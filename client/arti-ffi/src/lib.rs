//! STIQ Arti backend — `arti-mobile` cdylib entry point.
//!
//! =====================================================================================
//! STATUS (2026-07-27): this has bootstrapped and carried real traffic on a device, repeatedly —
//! not merely "the types line up".
//!
//! Direct Tor reaches the relay on a real handset, and so does obfs4 over a bridge (2.2s to a
//! working circuit, MEASURED 2026-07-27 — see pt.rs's module doc for the on-device capture). The
//! failure modes documented throughout this file were each observed on that same device, not
//! reasoned about in the abstract: the guard-manager lock race `create_client_retrying_lock`
//! exists for, the "bootstrap says 100%, no usable guards" lie `probe_reachability` exists to
//! catch (see its own doc for the 12-milliseconds-apart logcat capture), the state-lock leak
//! `rt_slot()` warns against reintroducing. Each fix below was verified against the specific
//! failure it names, on-device, not assumed.
//!
//! Still open, in the order it blocks things:
//!   * snowflake/webtunnel/meek_lite — wired the same way obfs4 is (tor-ptmgr + a `lib*.so`
//!     process per pt.rs's `binary_for`) and verified to build and accept the exact bridge-line
//!     shapes `bridges.ts` ships, but NOT yet exercised against tor-ptmgr on a real device the way
//!     obfs4 has been.
//!   * the post-bootstrap reachability probe below only runs when the config names a relay host
//!     (`relayOnion` or `onionAuth` — see `TorStartConfigJson`). The Rust side now accepts
//!     `relayOnion` so a PUBLIC community gets the same protection an auth-gated one does, but
//!     nothing upstream sends it yet — until the TS/Kotlin side is changed, a public community's
//!     probe coverage is unchanged from before this field existed.
//!   * on-device verification of all of the above, continuously, as arti and this file evolve.
//! =====================================================================================
//!
//! Lifecycle model:
//!   * A FRESH tokio runtime per daemon lifecycle (start → stop) — NOT one runtime shared for the
//!     whole process. A process-wide runtime was the original design and was REMOVED: dropping a
//!     `TorClient` does not abort the tasks arti spawned from it, so against unreachable bridges
//!     those tasks retried forever, held `state/state.lock`, and broke every subsequent start.
//!     `Runtime::shutdown_timeout` on stop is what frees that lock deterministically now — read
//!     `rt_slot()`'s doc in full before putting a shared runtime back.
//!   * ONE global `Mutex<Option<Handle>>` holding the live TorClient + SOCKS server, to mirror the
//!     single-daemon lifecycle the app expects (start → connected → stop).
//!   * Bootstrap progress is bridged from Arti's status stream to on_event("bootstrapping", …).
//!   * `connected` fires ONLY after the local SOCKS listener is bound and accepting, AND — when
//!     the config names a relay host — a real stream has reached it (see `probe_reachability`).

mod ffi;
#[cfg(target_os = "android")]
mod jni_bridge; // the Java_com_stiq_client_StiqArtiModule_* exports Kotlin binds to
mod onion_auth; // restricted-discovery client-auth key install
mod pt; // bridges + the managed pluggable transport
mod socks; // the local SOCKS5 proxy — the seam the whole app reaches Tor through

use arti_client::config::{BoolOrAuto, TorClientConfigBuilder};
use arti_client::{BootstrapBehavior, DormantMode, ErrorKind, HasKind as _, TorClient};
use ffi::{parse_config, ArtiBootstrap, TorStartConfigJson};
use futures::StreamExt as _;
use std::sync::{Mutex, OnceLock};
use tor_rtcompat::PreferredRuntime;

/// errno-style negative return codes for arti_start (the Kotlin side rejects the Promise on any).
pub mod codes {
    pub const ERR_BAD_CONFIG: i32 = -1; // JSON did not parse / missing required field
    pub const ERR_PT_UNSUPPORTED: i32 = -2; // non-'direct' transport requested in the spike (S5 gap)
    pub const ERR_BOOTSTRAP: i32 = -3; // TorClient failed to bootstrap
    pub const ERR_ONION_AUTH: i32 = -4; // restricted-discovery key could not be installed (S4)
    pub const ERR_SOCKS_BIND: i32 = -5; // could not bind/accept the local SOCKS listener
    pub const ERR_ALREADY_RUNNING: i32 = -6; // a client is already live; stop first
    /// Bootstrap "succeeded" but no circuit could actually be built — the transport is dead.
    /// Distinct from ERR_BOOTSTRAP on purpose: bootstrap did not fail, it lied. See
    /// `probe_reachability`.
    pub const ERR_NO_CIRCUIT: i32 = -7;
    /// arti_install_auth was called with no live client to install into (stopped, or a start
    /// still short of creating its TorClient). The caller retries after `connected`.
    pub const ERR_NOT_RUNNING: i32 = -8;
}

/// TCP port the relay onion is dialled on.
///
/// Not a guess: `StiqSocketModule.socks5Connect` derives it as
/// `val port = if (uri.port > 0) uri.port else 80`, and STIQ's relay URLs are `ws://<host>.onion`
/// with no explicit port — so 80 is literally the port the app asks for. Probing anything else
/// would report "service down" on a perfectly healthy path.
const PROBE_PORT: u16 = 80;

/// Ceiling on the reachability probe.
///
/// Generous, because an onion connect is descriptor fetch + introduction + rendezvous, none of
/// which is fast on a phone. Finite, because a probe that never returns is just the parked ladder
/// again wearing a different hat.
///
/// It also has to stay comfortably inside the JS-side deadline, or App.tsx gives up on the rung
/// while this is still running and the eventual `connected` arrives for an attempt nobody is
/// listening to. That deadline is "this long with NO forward progress" (TorManager.armTimeout),
/// re-armed on every percent increase — which is exactly why the `bootstrapping 99%` line below is
/// emitted immediately before the probe starts: it buys the probe a full, fresh budget instead of
/// making it share the tail of bootstrap's.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// How long to keep re-probing while arti reports "no path available".
///
/// ⚠ THIS IS WHAT MAKES BRIDGE RUNGS POSSIBLE. Without it the probe took a single shot, and on a
/// bridge rung that shot always lost. Device-measured 2026-07-28 (vc10): every obfs4 / snowflake /
/// webtunnel rung died with `TorAccessFailed` in **20-33 MILLISECONDS**, roughly 3s after start,
/// while the DIRECT rungs in the same run took 17-20 SECONDS to fail. Three orders of magnitude
/// apart is not a slow bridge, it is a rung that never got to try: arti finishes `bootstrap()` off
/// the CACHED CONSENSUS long before any PT has finished its handshake, our probe fires the instant
/// bootstrap returns, finds no circuit, and declares the transport dead. The ladder then cycled
/// direct -> webtunnel -> obfs4 -> snowflake -> direct forever, discarding every bridge in ~3s.
///
/// PROBE_TIMEOUT cannot fix this and adding to it would not have helped: arti does not HANG when
/// there is no path, it returns an error immediately, so the ceiling is never reached. The missing
/// ingredient is retrying, not waiting longer on one attempt.
///
/// Only no-path errors are retried. A service-level error (`OnionServiceNotFound` and friends)
/// could only have been discovered over a circuit that already works, so it returns at once and
/// keeps the rung — retrying it would just stall the ladder on a transport that is fine.
///
/// The cost is bounded and deliberate: a genuinely dead bridge rung now takes this long to fail
/// instead of ~3s. That is the price of ever letting a live one succeed.
const NO_PATH_GRACE: std::time::Duration = std::time::Duration::from_secs(40);

/// Gap between no-path retries. Small enough to catch a PT the moment it lands, large enough not to
/// spin the reactor while the handshake is in flight.
const NO_PATH_RETRY_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

/// Everything the running daemon owns; dropped by arti_stop.
struct Handle {
    /// Arti has no explicit shutdown call — dropping the last `TorClient` clone tears down the
    /// circuits and the background reactor. That is why the SOCKS server must be shut down at the
    /// same time: every live proxied connection holds a clone of this client, so dropping only the
    /// copy stored here would leave traffic flowing over Tor after `arti_stop` returned.
    /// `Arc<_>`, not a bare `TorClient`: arti-client 0.44's builder returns `Arc<TorClient<R>>` and
    /// `TorClient` itself is no longer `Clone`. The refcount that used to be internal is now this
    /// `Arc`, so "dropping the last clone" above still describes exactly what happens.
    client: std::sync::Arc<TorClient<PreferredRuntime>>,
    /// The bound listener + its shutdown signal. Its `port` is what we reported on `connected`.
    socks: socks::SocksServer,
    /// The HTTP CONNECT proxy port, or -1 when Arti exposes none (WebView-proxy gap — see decision doc).
    http_port: i32,
}

/// The tokio runtime the CURRENT daemon lifecycle runs on; `None` between a stop and the next start.
///
/// ⚠ This was a process-wide `OnceLock<Runtime>`. Putting one back re-breaks bridges — read this
/// before "simplifying" it.
///
/// Dropping a `TorClient` does NOT abort the tokio tasks arti spawned from it. dirmgr and chanmgr
/// keep retrying on tasks of their own, and each holds an `Arc` of the state manager, so
/// `state/state.lock` stays held for as long as those tasks keep running. `wait_for_stop()`
/// resolving does not mean the lock is free — it resolved in 845ms on a stop whose lock was still
/// held 30s later.
///
/// MEASURED 2026-07-27 (Samsung S23, release build): with unreachable bridges those retry loops are
/// effectively unbounded, so after a stop every subsequent rung died on "operation not implemented:
/// Error setting up the guard manager" and the ladder cascaded obfs4→snowflake→obfs4 forever.
/// Retrying harder is NOT a fix — 32 attempts (8s) failed, then 120 attempts (30s) failed the same
/// way. The tasks have to actually be aborted, and only the runtime that owns them can do that.
///
/// So the runtime's lifetime is now tied to the client's: `Runtime::shutdown_timeout` on stop aborts
/// every task, which drops the last `Arc` and releases the lock deterministically rather than
/// hopefully.
fn rt_slot() -> &'static Mutex<Option<tokio::runtime::Runtime>> {
    static RT: OnceLock<Mutex<Option<tokio::runtime::Runtime>>> = OnceLock::new();
    RT.get_or_init(|| Mutex::new(None))
}

fn new_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("arti-mobile")
        .build()
        .expect("arti-mobile: tokio runtime")
}

/// Abort every task on `rt` and wait, briefly, for its worker threads to unwind.
///
/// `shutdown_timeout` is the hard guarantee the graceful drain cannot give: a task parked on a
/// bridge dial that will never complete is DROPPED rather than awaited, so this returns promptly
/// even while the network is black-holing every connection.
///
/// Deliberately short. This is the LAST step of `arti_stop`'s teardown (see its `GRACEFUL_BUDGET`
/// doc), so its budget is additive with everything before it — it used to be 3s, making that
/// total 8s worst case for what the comments there call "a preset switch the user is watching".
/// 2s is still generous for what this step actually is: not "wait for a clean stop" (the abort
/// already happened; nothing here is graceful), just "give the now-aborted worker threads a
/// moment to notice and unwind before we stop waiting regardless".
///
/// Must be called from OUTSIDE the runtime (it panics otherwise). Every caller here is on the JNI
/// thread, after `block_on` has already returned.
fn shutdown_runtime(rt: tokio::runtime::Runtime) {
    const SHUTDOWN_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);
    rt.shutdown_timeout(SHUTDOWN_BUDGET);
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
    // Mirror every event to logcat.
    //
    // Without this the ONLY consumer of an error string is the JS layer, which renders it as a
    // "Disconnected" strip. On the first device run that made a daemon which failed in under a
    // second completely undiagnosable: the library loaded, startTor ran, an error came back, and
    // nothing anywhere said what it was. An embedded daemon has to be able to explain itself.
    #[cfg(target_os = "android")]
    if kind == "error" {
        log::error!("error: {message}");
    } else {
        log::info!("{kind} {percent}% {summary} socks={socks_port}");
    }

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

/// Render an arti error for a log line or an emitted UI message: the stable `ErrorKind` (a small,
/// closed enum tag, never identifying) plus a `safelog`-wrapped rendering of the error's own
/// Display text.
///
/// NEVER interpolate an `arti_client::Error` into a log/emit string with a raw `{e}`. Some of
/// arti's own error variants embed the specific relay identities a client picked while trying to
/// reach a hidden service — e.g. tor-hsclient's descriptor-fetch error carries the HsDir it tried
/// (`hsdir: Sensitive<Ed25519Identity>`) and its rendezvous-failure variants carry the rendezvous
/// point (`rend_pt: Redacted<RelayIds>`) — re-verified still true at tor-hsclient-0.44.0/src/err.rs
/// on the 0.28 → 0.44 bump; five separate variants carry `rend_pt`. Which relays a client
/// selected for a given connection is exactly the metadata that makes its circuits correlatable,
/// in an app whose entire threat model is anonymity.
///
/// Those specific fields already redact themselves by default: `Sensitive`/`Redacted`'s `Display`
/// checks a process-global flag that starts, and stays, "safe" unless something calls
/// `safelog::disable_safe_logging()` — nothing in this crate does. But that protection lives
/// several crates away, in code we do not own, and is not something to depend on transitively
/// forever: a future arti release could add a variant that is less careful, or route a failure
/// through a sub-crate that never adopted `safelog`. Wrapping the WHOLE error in
/// `safelog::sensitive()` here — the same idiom `tor_guardmgr::Guard`'s own Display uses for the
/// relay it names — gives STIQ a LOCAL, self-contained guarantee that does not rely on auditing
/// arti's internals on every dependency bump: by default this can never render more than
/// `[scrubbed]`, no matter what any current or future arti sub-crate's Display chain does.
///
/// `kind()` is untouched (and always shown unredacted) because it is what `transport_is_dead` and
/// the retry-vs-fail logic elsewhere in this file actually branch on — losing it would make a
/// wrong verdict impossible to re-litigate from a logcat capture alone.
pub(crate) fn describe_arti_error(e: &arti_client::Error) -> String {
    format!("{:?}: {}", e.kind(), safelog::sensitive(e))
}

/// Register the bootstrap callback. Called once by StiqArtiModule during module init.
/// (uniffi generates the boxing; the plain-extern variant stores a raw fn ptr + ctx instead.)
pub fn arti_set_callback(cb: Box<dyn ArtiBootstrap>) {
    *callback_slot().lock().unwrap() = Some(cb);
}

/// Start the embedded Arti daemon. Returns the bound SOCKS port (>0) on success, or a negative
/// `codes::*` value on failure (also emitting on_event("error", …)). See ffi.rs for the JSON shape.
/// Select rustls' crypto provider once per process, before any TLS can be constructed.
///
/// ⚠ DO NOT REMOVE. Without this, arti 0.44 ABORTS THE PROCESS on the very first start — SIGABRT
/// with "Could not automatically determine the process-level CryptoProvider from Rustls crate
/// features", 3ms after "bootstrapping 1% Configuring Arti". Device-reproduced on 2026-07-28
/// (vc10, SM-S918B); it is a hard abort, not a recoverable error, so no amount of error handling
/// upstream helps.
///
/// Why it happens: rustls 0.23 refuses to guess. It picks a default provider only when exactly one
/// of ITS OWN `ring` / `aws-lc-rs` features is enabled. arti depends on rustls with
/// `default-features = false` precisely so the final binary chooses — which means the choice is
/// ours to make and, until now, nobody made it. Note that `ring` being present in Cargo.lock is NOT
/// sufficient and is what makes this trap convincing: the crate is in the graph (rustls-webpki
/// pulls it), while rustls' `ring` FEATURE stayed off.
///
/// This is belt-and-braces with the explicit `rustls` dependency in Cargo.toml. The feature alone
/// would do it, but feature unification across ~420 crates is not something to bet a hard abort on;
/// an install_default() call is unambiguous. Idempotent by design: it returns Err once a provider
/// is installed, which is the normal case for every start after the first in a process lifetime, so
/// the result is deliberately discarded.
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            log::debug!("rustls CryptoProvider was already installed; keeping the existing one");
        }
    });
}

pub fn arti_start(config_json: String) -> i32 {
    // Before ANYTHING that could touch TLS — see ensure_crypto_provider(); getting this wrong is a
    // process abort, not an error return.
    ensure_crypto_provider();

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

    // A fresh lifecycle verifies afresh. Normally arti_stop already reset this; this covers the
    // failure path where a start never populated the slot (its runtime was shut down below, so no
    // stale verification can be running either).
    verify_gate().store(false, std::sync::atomic::Ordering::SeqCst);

    // A fresh runtime per lifecycle — see rt_slot(). Any runtime from a previous lifecycle has
    // already been shut down, either by arti_stop or by the failure path just below.
    let rt = new_runtime();
    let code = rt.block_on(async move { start_async(cfg).await });

    // Keep the runtime ONLY if a client actually landed in the slot. `handle_slot` is the
    // authoritative "did we start" signal — more robust than matching on the code, and the two
    // cannot disagree because finish_start populates it as its last act.
    //
    // The else-branch is the one that matters for the ladder: a rung that FAILED still spawned
    // tasks, and leaving them running is precisely what holds state/state.lock and kills the next
    // rung. Nothing will ever call arti_stop for a start that never succeeded, so it has to abort
    // them here.
    // Read the handle slot into a bool FIRST so its guard is released before rt_slot is locked.
    // Writing this as `if handle_slot().lock()…is_some() { *rt_slot().lock()… }` holds both locks at
    // once (the condition's temporary lives to the end of the `if` statement), which would be the
    // only place in this file that nests them — an easy deadlock to introduce later.
    let started = handle_slot().lock().unwrap().is_some();
    if started {
        *rt_slot().lock().unwrap() = Some(rt);
    } else {
        shutdown_runtime(rt);
    }
    code
}

async fn start_async(cfg: TorStartConfigJson) -> i32 {
    // One line naming everything that decides which path below runs. Deliberately logs the SHAPE of
    // the credentials (how many, and their lengths) and never their contents — a client-auth secret
    // in logcat would be a reach credential leaked to every app that can read logs.
    #[cfg(target_os = "android")]
    log::info!(
        "start: transport={} bridges={} socksPort={} dataDir={:?} nativeLibDir={:?} auth={}+{}",
        cfg.transport,
        cfg.bridge_lines.len(),
        cfg.socks_port,
        cfg.data_dir,
        cfg.native_lib_dir,
        cfg.onion_auth.is_some() as u8,
        cfg.onion_auth_extra.len(),
    );
    emit("bootstrapping", 1, "Configuring Arti", 0, "");

    // ── 1. Validate restricted-discovery credentials (lever 2) ───────────────────────────────────
    // Shape-check every credential up front so a malformed one fails in milliseconds rather than
    // after a full bootstrap. The keys are installed further down, once there is a client to install
    // them into; both steps fail CLOSED, because an unauthorized client must not connect at all —
    // that is the whole point of lever 2.
    let secrets = match decode_auth_entries(&cfg.onion_auth, &cfg.onion_auth_extra) {
        Ok(s) => s,
        Err(msg) => {
            emit("error", 0, "", 0, &msg);
            return codes::ERR_ONION_AUTH;
        }
    };

    // ── 2. Build the client config (including bridges + the PT binary) ───────────────────────────
    let config = match build_config(&cfg) {
        Ok(c) => c,
        Err((code, msg)) => {
            emit("error", 0, "", 0, &msg);
            return code;
        }
    };

    // Take the runtime handle explicitly. `TorClient::builder()` calls `PreferredRuntime::current()`
    // and `.expect()`s it — and this crate builds with `panic = "abort"`, so that would take the
    // whole app down instead of rejecting a promise.
    let runtime = match PreferredRuntime::current() {
        Ok(rt) => rt,
        Err(e) => {
            emit("error", 0, "", 0, &format!("no async runtime: {e}"));
            return codes::ERR_BOOTSTRAP;
        }
    };

    // ── 3. Create unbootstrapped, then bootstrap ─────────────────────────────────────────────────
    // Deliberately NOT `create_bootstrapped()`: the progress stream has to be attached before
    // bootstrap starts, otherwise the early phases (which on mobile are most of the wall clock) are
    // already over by the time anyone is listening, and the UI sits at 0% and then jumps.
    let client = match create_client_retrying_lock(runtime, config).await {
        Ok(c) => c,
        Err(e) => {
            emit(
                "error",
                0,
                "",
                0,
                &format!("create client: {}", describe_arti_error(&e)),
            );
            return codes::ERR_BOOTSTRAP;
        }
    };

    // Install the reach credentials before bootstrapping. They are only consulted at descriptor
    // fetch time, but doing it here means a keystore problem is reported in milliseconds instead of
    // after a minute of bootstrap — and it keeps the failure attributable to the credential rather
    // than to the network.
    for (host, secret) in &secrets {
        if let Err(msg) = onion_auth::install_into_keymgr(&client, host, *secret) {
            emit("error", 0, "", 0, &format!("onion-auth: {msg}"));
            return codes::ERR_ONION_AUTH;
        }
    }

    let mut events = client.bootstrap_events();
    let pump = tokio::spawn(async move {
        while let Some(status) = events.next().await {
            // Clamp to 98, not 99, and not 100.
            //
            // 100 belongs to `connected`, and `connected` is only honest once the SOCKS listener is
            // accepting — see the emission-order contract in ffi.rs. 99 is now reserved for the
            // reachability probe below, which is a real phase with real wall-clock cost: giving it
            // its own percent is what re-arms TorManager's no-progress deadline for it (that timer
            // only resets on a percent INCREASE), and it stops the bar sitting at a silent 99 while
            // the probe runs.
            let percent = ((status.as_frac() * 100.0).round() as i32).clamp(1, 98);
            emit("bootstrapping", percent, &status.to_string(), 0, "");
        }
    });

    let bootstrap_result = client.bootstrap().await;
    pump.abort();
    if let Err(e) = bootstrap_result {
        emit(
            "error",
            0,
            "",
            0,
            &format!("bootstrap: {}", describe_arti_error(&e)),
        );
        return codes::ERR_BOOTSTRAP;
    }

    // ── 3b. Decide what the post-connect verification will dial ─────────────────────────────────
    //
    // BOOTSTRAP REACHING 100% DOES NOT MEAN THE TRANSPORT WORKS. Arti's bootstrap status tracks
    // whether the DIRECTORY is usable, and a cached consensus satisfies that without a single
    // working channel. MEASURED 2026-07-27 on the obfs4 preset, whose bridges are unreachable from
    // that network:
    //
    //     08:43:42.719  tor_circmgr::mgr: … Unable to select a guard relay: No usable guards.
    //                   Rejected 27/29 as down, then 0/2 as pending, then 2/2 as unsuitable …
    //     08:43:42.731  arti_mobile: connected 100% Connected socks=40469
    //
    // Twelve milliseconds apart: the daemon announced a working Tor while being incapable of
    // carrying one byte. The probe that catches that lie used to run RIGHT HERE, blocking
    // `connected` — and it cost every healthy connect 6-16 s of onion round-trip (DEVICE-MEASURED
    // 2026-07-28: 6.2 s warm / 14.0 s cold on a network where everything worked). That tax, paid
    // by every user on every launch, was the single largest reason an Arti connect felt no faster
    // than C-tor. So the probe is now a BACKGROUND VERIFICATION spawned after `connected` (see
    // `spawn_verify` below): the happy path pays nothing, and a lying rung is condemned a few
    // seconds later via the `transport-dead` event instead of by a blocked start.
    //
    // The JS ladder handles the deferred verdict (App.tsx): `verified` is what records a rung as
    // warm/known-good, and `transport-dead` marks the rung dead for the session, tears the daemon
    // down and re-walks the ladder from the next rung — the same recovery it already ran when a
    // connected transport was condemned by relay failures.
    //
    // Prefer an explicit `relayOnion` when the caller sends one; fall back to the onion-auth
    // credential's host otherwise. `cfg.onion_auth` being `None` does NOT mean "no relay" — see
    // its doc in ffi.rs — so it cannot by itself be read as "nothing to probe"; it means a PUBLIC
    // relay onion with no client authorization, and that community's user hits the exact same
    // dead-bridge lie this probe exists to catch. `relay_onion` is what lets the probe cover them
    // too. `.filter` guards against an empty string being sent instead of the field being omitted.
    let probe_host: Option<String> = cfg
        .relay_onion
        .as_deref()
        .filter(|h| !h.is_empty())
        .or_else(|| cfg.onion_auth.as_ref().map(|a| a.onion_host.as_str()))
        .map(String::from);

    if probe_host.is_none() {
        // Neither field names a relay host. There is nothing STIQ-owned to dial, and inventing a
        // canary target would mean the app making a connection its user never asked for — to a
        // third party, over the very transport we are unsure about. An early start (before the
        // app's runtime hydrates the active community) lands here too; arti_install_auth supplies
        // the host later and starts the same verification then.
        #[cfg(target_os = "android")]
        log::info!("no relay host configured (relayOnion/onionAuth both absent); reachability will be verified when one arrives");
    }

    // Bind the SOCKS listener and announce `connected` FIRST — the verification must never block
    // the start again. On failure `handle_slot` is still empty, which is the signal `arti_start`
    // uses to `shutdown_runtime(rt)`; on a post-`connected` `transport-dead` the teardown is the
    // JS side's ordinary stop-then-next-rung path instead, exactly as if the rung had been
    // condemned by relay failures.
    let client_for_verify = std::sync::Arc::clone(&client);
    let code = finish_start(cfg, client).await;
    if code > 0 {
        if let Some(host) = probe_host {
            spawn_verify(client_for_verify, host);
        }
    }
    code
}

/// One background reachability verification per daemon lifecycle.
///
/// `false` → no verification has run (or one is in flight); set back to `false` by `arti_stop` so
/// the next lifecycle verifies afresh. A CAS gate rather than a queue: `arti_start` and
/// `arti_install_auth` can both ask for verification (early start followed by a late credential
/// install), and one live probe answers for both — the question is per-transport, not per-caller.
fn verify_gate() -> &'static std::sync::atomic::AtomicBool {
    static GATE: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();
    GATE.get_or_init(|| std::sync::atomic::AtomicBool::new(false))
}

/// Spawn the post-connect reachability verification. Must be called from within the lifecycle
/// runtime (arti_start) or handed its handle (arti_install_auth); the task lives on the same
/// runtime as the client, so `arti_stop`'s `shutdown_timeout` aborts it deterministically — a
/// stale probe can never emit into the NEXT lifecycle.
///
/// Emits exactly one of:
///   * `verified`       — a stream reached the relay onion, OR the failure was service-level
///                        (which can only be learned over a working circuit). Either way the
///                        TRANSPORT demonstrably works; the JS side records the rung warm.
///   * `transport-dead` — no circuit could be built at all (see `probe_reachability`'s no-path
///                        retry contract). The JS side condemns the rung and re-walks the ladder.
fn spawn_verify(client: std::sync::Arc<TorClient<PreferredRuntime>>, host: String) {
    use std::sync::atomic::Ordering;
    if verify_gate()
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // a verification for this lifecycle already ran or is running
    }
    tokio::spawn(async move {
        match probe_reachability(&client, &host).await {
            Probe::Reachable => {
                emit("verified", 100, "Connected", 0, "");
            }
            // Tor works; our own relay did not answer. NOT the transport's fault, and condemning
            // it would cycle the entire ladder — every rung failing identically — every time the
            // community relay restarts. Report the transport verified and let the app's own relay
            // retry logic deal with a relay outage the way it always has.
            Probe::ServiceUnreachable(msg) => {
                #[cfg(target_os = "android")]
                log::warn!("{msg}; Tor itself is working, so keeping this transport");
                #[cfg(not(target_os = "android"))]
                let _ = msg;
                emit("verified", 100, "Connected", 0, "");
            }
            Probe::TransportDead(msg) => {
                // Leave the gate set: this lifecycle's verdict is in, and the JS side is about to
                // stop the daemon anyway (arti_stop resets the gate for the next rung).
                emit("transport-dead", 0, "", 0, &msg);
            }
        }
    });
}

/// Shape-check + decode the (primary + secondary) reach credentials into installable secrets.
///
/// The error string is ready to emit: it names LENGTHS, never values — "host 62 chars, key 52" is
/// the whole diagnosis when a caller passes a URL where a bare host was expected, and a client-auth
/// secret in logcat would be a reach credential leaked to every app that can read logs.
fn decode_auth_entries(
    onion_auth: &Option<ffi::OnionAuthJson>,
    extra: &[ffi::OnionAuthJson],
) -> Result<Vec<(String, [u8; 32])>, String> {
    let mut auth_entries = Vec::new();
    if let Some(a) = onion_auth {
        auth_entries.push(a);
    }
    for a in extra {
        auth_entries.push(a);
    }
    let mut secrets = Vec::with_capacity(auth_entries.len());
    for a in &auth_entries {
        if let Err(msg) = onion_auth::validate_entry(&a.onion_host, &a.priv_key_base32) {
            return Err(format!(
                "onion-auth: {msg} (host is {} chars, key is {} chars)",
                a.onion_host.len(),
                a.priv_key_base32.len()
            ));
        }
        match onion_auth::decode_secret(&a.priv_key_base32) {
            Ok(secret) => secrets.push((a.onion_host.clone(), secret)),
            Err(msg) => return Err(format!("onion-auth: {msg}")),
        }
    }
    Ok(secrets)
}

/// Install reach credentials into the LIVE client and kick the deferred reachability verification.
///
/// This is the second half of the early-start contract (task: cut the pre-`startTor` wait). The
/// app may now start Arti BEFORE its runtime has hydrated the active community — bootstrap needs
/// no credential; Arti consults its KeyMgr keystore at DESCRIPTOR-FETCH time, not at startup (the
/// "must restart Tor to load a key" rule was C-tor's ClientOnionAuthDir semantics and does not
/// apply here). When hydration later yields the community's credential + relay host, the JS side
/// calls this instead of restarting the daemon, then dials the relay.
///
/// Idempotent: installing an already-installed key overwrites it in place, and `spawn_verify`'s
/// gate collapses a second verification request into the one already running/answered.
///
/// Returns 0 on success, or a negative `codes::*` value. `ERR_NOT_RUNNING` when there is no live
/// client — the caller retries after `connected`.
pub fn arti_install_auth(json: String) -> i32 {
    let req = match ffi::parse_install_reach(&json) {
        Ok(r) => r,
        Err(e) => {
            emit("error", 0, "", 0, &format!("install-auth config: {e}"));
            return codes::ERR_BAD_CONFIG;
        }
    };
    let secrets = match decode_auth_entries(&req.onion_auth, &req.onion_auth_extra) {
        Ok(s) => s,
        Err(msg) => {
            emit("error", 0, "", 0, &msg);
            return codes::ERR_ONION_AUTH;
        }
    };

    // Clone the client Arc out of the slot rather than holding the lock across keystore writes —
    // an event callback re-entering a lock this thread holds is exactly the kind of deadlock the
    // handle mutex must never be exposed to.
    let client = match handle_slot().lock().unwrap().as_ref() {
        Some(h) => std::sync::Arc::clone(&h.client),
        None => return codes::ERR_NOT_RUNNING,
    };

    #[cfg(target_os = "android")]
    log::info!(
        "install-auth: {} credential(s), relayOnionLen={}",
        secrets.len(),
        req.relay_onion.as_deref().map_or(0, |h| h.len()), // length only, never the host
    );

    for (host, secret) in &secrets {
        if let Err(msg) = onion_auth::install_into_keymgr(&client, host, *secret) {
            emit("error", 0, "", 0, &format!("onion-auth: {msg}"));
            return codes::ERR_ONION_AUTH;
        }
    }

    // Same precedence as start_async: explicit relayOnion first, else the primary credential's
    // host. An early start had no host to verify against, so this is usually the FIRST (and only)
    // verification of the lifecycle.
    let probe_host: Option<String> = req
        .relay_onion
        .as_deref()
        .filter(|h| !h.is_empty())
        .or_else(|| req.onion_auth.as_ref().map(|a| a.onion_host.as_str()))
        .map(String::from);
    if let Some(host) = probe_host {
        // This runs on the JNI thread; the verification must live on the lifecycle runtime so
        // arti_stop's shutdown aborts it with everything else.
        let handle = rt_slot()
            .lock()
            .unwrap()
            .as_ref()
            .map(|rt| rt.handle().clone());
        if let Some(handle) = handle {
            let _guard = handle.enter();
            spawn_verify(client, host);
        }
    }
    0
}

/// What the reachability probe learned.
enum Probe {
    /// A stream reached the relay onion. This transport demonstrably carries traffic.
    Reachable,
    /// Tor could not build a usable path — the transport is dead and the ladder must move on.
    TransportDead(String),
    /// Tor works, but the service did not answer. The transport is fine; the relay is down.
    ServiceUnreachable(String),
}

/// Does this failure mean the TRANSPORT is dead, as opposed to the relay simply being down?
///
/// This discrimination is the whole point of the probe, and getting it wrong is costly in BOTH
/// directions, so each bucket is justified rather than guessed:
///
///   * Too lenient → we are back to the bug: a dead rung reports success and the ladder parks.
///   * Too aggressive → a relay outage takes the app fully OFFLINE. The ladder would cycle every
///     transport, each failing identically because the fault was never the transport, and land
///     nowhere. That is worse than today's behaviour, so an unrecognised failure must fall on the
///     lenient side.
///
/// Every variant below was read out of `tor-error-0.44.0/src/lib.rs` and traced to the code that
/// raises it; `ErrorKind` is `#[non_exhaustive]`, hence the `_` arm.
///
/// RE-AUDITED on the 0.28 → 0.44 bump (Arti 1.4.1 → 2.5.0) by diffing the enum's variant list
/// across both crate versions: **nothing was renamed, split, or removed** — 57 variants at 0.28,
/// the same 57 plus exactly two additions at 0.44 (`SoftwareDeprecated`, `TorDocumentRejected`).
/// Both new ones are handled by the `_` arm below and both belong there: see its comment.
fn transport_is_dead(kind: ErrorKind) -> bool {
    use ErrorKind as EK;
    match kind {
        // ── DEAD: no circuit could be built through the configured entry point ───────────────────

        // The measured one. `tor-guardmgr`'s `PickGuardError::AllGuardsDown` — the literal "No
        // usable guards. Rejected 27/29 as down …" line from the capture above — maps here, and so
        // does every `tor-chanmgr` channel failure (`ChanTimeout`, `Io`, `ChannelBuild`,
        // `PendingFailed`). Its own doc: "Perhaps the local network is not working, or perhaps the
        // chosen relay or bridge is not working properly." That IS "this transport is dead".
        EK::TorAccessFailed
        // `PickGuardError::NoCandidatesAvailable` and `tor-circmgr`'s `NoRelay`: we could not
        // assemble a path at all. With bridges configured that means the bridge set is unusable.
        | EK::NoPath
        // Same class as NoPath (tor-error's own docs say some cases of a broken directory surface
        // as one or the other). STIQ builds no exit circuits, so this is not expected — but if it
        // ever appears it is still "could not construct a path".
        | EK::NoExit
        // `tor-hsclient`'s `ConnError::NoHsDirs`, plus a consensus too broken to use. The directory
        // being unusable is the *cause* of the lie this probe exists to catch, not a symptom of the
        // relay being down.
        | EK::TorDirectoryUnusable
        // "Our network directory has expired before we were able to replace it" — i.e. we are
        // running on a stale cached consensus and could not refresh it. Exactly the state that lets
        // bootstrap report 100% with no working channel.
        | EK::DirectoryExpired
        // Should be impossible here (we just bootstrapped), but if arti says it is not bootstrapped
        // then Tor is not usable on this rung.
        | EK::BootstrapRequired
        // A timeout INSIDE the Tor network: `tor-circmgr`'s `CircTimeout`/`RequestTimeout` (a
        // circuit could not be built in time) and a directory fetch that never answered.
        //
        // The honest caveat: `tor-hsclient` also maps `IntroductionTimeout` and
        // `RendezvousEstablishTimeout` here, which need a working circuit and therefore prove the
        // transport is alive. It is still classified DEAD, because the relay-is-down cases have
        // their own dedicated kinds (`OnionServiceNotFound` when the HsDir has no descriptor,
        // `OnionServiceConnectionFailed` when the intro point rejects us, `RemoteNetworkTimeout`
        // when the service never completes the rendezvous) and land in the lenient bucket below.
        // The residual cost of being wrong here is one extra ladder rung, not a parked ladder.
        | EK::TorNetworkTimeout
        // `tor-ptmgr`: the pluggable-transport process timed out, died, or refused to speak the
        // protocol. Only reachable on a PT rung, and it means that rung has no transport at all.
        | EK::ExternalToolFailed => true,

        // ── ALIVE: Tor works; the SERVICE did not answer ─────────────────────────────────────────

        // The HsDir had no descriptor (404), the descriptor was undecryptable, the intro points
        // rejected us, the service never completed the rendezvous. Every one of these required a
        // working circuit to discover, so the transport is proven good by their very existence.
        EK::OnionServiceNotFound
        | EK::OnionServiceNotRunning
        | EK::OnionServiceProtocolViolation
        | EK::OnionServiceConnectionFailed
        // Our client-auth credential is missing or stale. A real problem, but no transport can fix
        // it — and socks.rs already maps these to the 0xF4/0xF5 replies SocksReply.kt treats as
        // permanent, which is where the user-facing diagnosis belongs.
        | EK::OnionServiceMissingClientAuth
        | EK::OnionServiceWrongClientAuth
        | EK::OnionServiceAddressInvalid
        // Everything beyond the far end of a circuit. Reaching a verdict about the remote at all
        // means bytes crossed the Tor network.
        | EK::RemoteConnectionRefused
        | EK::RemoteNetworkTimeout
        | EK::RemoteNetworkFailed
        | EK::RemoteHostNotFound
        | EK::RemoteHostResolutionFailed
        | EK::RemoteStreamClosed
        | EK::RemoteStreamReset
        | EK::RemoteStreamError
        | EK::RemoteProtocolViolation
        | EK::ExitPolicyRejected
        | EK::ExitTimeout
        // A circuit existed and then collapsed, or a relay was too busy. Either way one was built,
        // so the transport carried traffic.
        | EK::CircuitCollapse
        | EK::RelayTooBusy => false,

        // Everything else: local/config/keystore/bug classes (`InvalidConfig`,
        // `KeystoreAccessFailed`, `FsPermissions`, `Internal`, `BadApiUsage`, `Other`, …), plus any
        // variant a future arti adds to this `#[non_exhaustive]` enum.
        //
        // The two variants 0.44 added both land here, and both were checked rather than assumed:
        //   * `SoftwareDeprecated` — "the directory authorities tell us we ought to have a protocol
        //     feature we do not support". A property of THIS BINARY, identical on every rung, so
        //     failing the rung would cycle the whole ladder and land nowhere. Lenient is right.
        //   * `TorDocumentRejected` — we rejected a directory document as malformed/unparseable.
        //     Tempting to call this a dead directory, but arti's own doc says it can equally be our
        //     bug, our being out of date, or one misbehaving remote — none of which another rung
        //     fixes. Note the genuinely transport-fatal directory states keep their own dedicated
        //     kinds (`TorDirectoryUnusable`, `DirectoryExpired`) and are classified DEAD above.
        //
        // DELIBERATE CHOICE: do not fail the rung. None of these is a property of the transport, so
        // every rung would fail the same way and the ladder would cycle to no purpose while the app
        // stays offline. The unknown case must fall on the side that cannot make things worse than
        // they were before this probe existed.
        _ => false,
    }
}

/// Open one real stream to the relay onion and classify what happens.
///
/// `onion_host` is the 56-char v3 host WITHOUT the `.onion` suffix (see ffi.rs); the suffix is
/// appended here for the same reason `onion_auth::install_into_keymgr` appends it.
async fn probe_reachability(client: &TorClient<PreferredRuntime>, onion_host: &str) -> Probe {
    let target = format!("{onion_host}.onion");
    // The SOCKS server's own policy for an un-credentialled stream, reused rather than restated so
    // there is one definition of it: onion addresses explicitly permitted, and `isolate_every_stream`
    // so the probe's circuit is never shared with the app's traffic.
    let prefs = socks::stream_prefs(None);

    let started = std::time::Instant::now();
    let deadline = started + NO_PATH_GRACE;
    let mut attempts: u32 = 0;

    // Retry while arti says "no path" — see NO_PATH_GRACE. A single attempt is correct for a DIRECT
    // rung (guards are already warm, so no-path means no-path) and catastrophically wrong for a
    // BRIDGE rung, where arti returns that error instantly for tens of seconds while the PT is still
    // completing its handshake.
    loop {
        attempts += 1;
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        // Never hand `timeout` a zero budget on the final attempt; one second is enough for arti to
        // answer from state it already has, which is all a no-path error ever needs.
        let budget = PROBE_TIMEOUT.min(remaining.max(std::time::Duration::from_secs(1)));

        let outcome = tokio::time::timeout(
            budget,
            client.connect_with_prefs((target.as_str(), PROBE_PORT), &prefs),
        )
        .await;

        match outcome {
            Ok(Ok(stream)) => {
                // Nothing is sent. The service answering CONNECTED for this port is already proof
                // that a rendezvous circuit was built end to end, which is the entire question.
                drop(stream);
                #[cfg(target_os = "android")]
                log::info!(
                    "reachability probe reached the relay in {:?} (attempt {attempts})",
                    started.elapsed()
                );
                return Probe::Reachable;
            }
            Ok(Err(e)) => {
                let kind = e.kind();
                // Does NOT name the onion host, and does NOT interpolate `e` raw — see
                // `describe_arti_error`'s doc: arti's own hidden-service errors can carry the
                // specific HsDir/rendezvous relay identities this client picked, which is exactly
                // the metadata that makes a client's circuits correlatable. This string reaches the
                // UI and logcat, which every app on the device can read.
                let msg = format!(
                    "reachability probe failed after {:?} ({})",
                    started.elapsed(),
                    describe_arti_error(&e)
                );

                // A service-level error could only have been discovered OVER a working circuit, so
                // the transport is fine and retrying proves nothing. Return immediately.
                if !transport_is_dead(kind) {
                    return Probe::ServiceUnreachable(msg);
                }

                if std::time::Instant::now() >= deadline {
                    return Probe::TransportDead(format!(
                        "{msg} — no usable path after {attempts} attempts over {:?}; \
                         escalating transport",
                        started.elapsed()
                    ));
                }

                #[cfg(target_os = "android")]
                log::debug!(
                    "reachability probe: no path yet on attempt {attempts} ({}); \
                     retrying — a PT handshake is not instant",
                    describe_arti_error(&e)
                );
                tokio::time::sleep(NO_PATH_RETRY_EVERY).await;
            }
            Err(_) => {
                return Probe::TransportDead(format!(
                    "reachability probe timed out after {budget:?}; \
                     tor bootstrapped but could not carry a stream — escalating transport"
                ))
            }
        }
    }
}

/// Build the client, retrying briefly while the previous one still holds the state-directory lock.
///
/// THE FAILURE THIS EXISTS FOR is worth spelling out, because the error message actively misleads.
/// The connect ladder tears the client down and builds a new one for each rung, but dropping a
/// `TorClient` does not release `state/state.lock` synchronously — its background tasks do, once
/// they finish unwinding. The next rung races them. When it loses, and only when bridges are
/// configured, `GuardMgr` reports the missed lock as `NoLock`, which maps to
/// `ErrorKind::NotImplemented`, which renders as:
///
///     tor: operation not implemented: Error setting up the guard manager
///
/// — a message that sounds like a missing cargo feature and mentions neither locks nor bridges. It
/// appears only on bridge rungs because the no-bridge path never consults the lock at all, which
/// makes it look like broken PT support rather than a race.
///
/// `TorClientBuilder::local_resource_timeout` does NOT cover this. That retry only fires for the
/// state manager's own `try_lock`; arti-client deliberately ignores that result and lets GuardMgr
/// fail later, so the builder returns a hard error in about four milliseconds. Hence an explicit
/// retry here. It is bounded, and any other error returns immediately.
async fn create_client_retrying_lock(
    runtime: PreferredRuntime,
    config: arti_client::TorClientConfig,
) -> Result<std::sync::Arc<TorClient<PreferredRuntime>>, arti_client::Error> {
    /// Backstop only. `SocksServer::shutdown` now drains the connection tasks before `arti_stop`
    /// returns, so in the normal case attempt 1 succeeds and none of this runs. The budget stays
    /// generous because the cost of being wrong is asymmetric: a few wasted seconds on a rung that
    /// was going to fail anyway, versus a daemon that can only ever start once per process.
    // A BACKSTOP, and only that. `arti_stop` now aborts the previous lifecycle's tasks via
    // `Runtime::shutdown_timeout` (see rt_slot()), so the lock is already free by the time we get
    // here and attempt 1 succeeds.
    //
    // Do NOT try to fix a lock leak by raising this. That was tried on 2026-07-27 and MEASURED to
    // fail: 32 attempts (8s) failed, 120 attempts (30s) failed identically, because the tasks
    // holding the lock were in unbounded retry loops against unreachable bridges and no amount of
    // waiting was ever going to outlast them. Aborting the tasks is the fix; this is just insurance
    // against a slow unwind on the happy path.
    const ATTEMPTS: u32 = 20;
    const DELAY: std::time::Duration = std::time::Duration::from_millis(250);

    let started = std::time::Instant::now();
    let mut last: Option<arti_client::Error> = None;
    for attempt in 0..ATTEMPTS {
        match build_client(&runtime, config.clone()) {
            Ok(c) => {
                // Log the wait, not just the fact of it: if this ever starts taking seconds again
                // it means the drain regressed, and that is invisible without a number.
                #[cfg(target_os = "android")]
                if attempt > 0 {
                    log::info!(
                        "state lock acquired on attempt {} after {:?}",
                        attempt + 1,
                        started.elapsed()
                    );
                }
                return Ok(c);
            }
            // `NotImplemented` from client creation is, in practice, only ever this lock race:
            // nothing else in the construction path is unimplemented in a build that has already
            // succeeded once. Anything else is a real failure and must not be retried.
            Err(e) if e.kind() == arti_client::ErrorKind::NotImplemented => {
                #[cfg(target_os = "android")]
                log::warn!(
                    "state lock still held (attempt {}/{ATTEMPTS}); the previous client is still \
                     unwinding",
                    attempt + 1
                );
                last = Some(e);
                tokio::time::sleep(DELAY).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.expect("loop ran at least once"))
}

fn build_client(
    runtime: &PreferredRuntime,
    config: arti_client::TorClientConfig,
) -> Result<std::sync::Arc<TorClient<PreferredRuntime>>, arti_client::Error> {
    TorClient::with_runtime(runtime.clone())
        .config(config)
        .bootstrap_behavior(BootstrapBehavior::Manual)
        // Wait for the state-directory lock instead of failing the instant it is busy.
        //
        // The connect ladder tears the client down and builds a new one for each rung, but a
        // dropped TorClient does not release `state/state.lock` synchronously — its background
        // tasks do, once they finish unwinding. The next rung then races them.
        //
        // The failure that produces is spectacularly unhelpful: with bridges configured, GuardMgr
        // reports the missed lock as `NoLock`, which maps to ErrorKind::NotImplemented, which
        // renders as "operation not implemented: Error setting up the guard manager" — a message
        // that sounds like a missing cargo feature and says nothing about a lock. It also only
        // appears on bridge rungs, because the no-bridge path never consults the lock at all.
        //
        // Also let arti retry the state manager's own lock. It does not cover the GuardMgr case
        // above — that is what the loop in `create_client_retrying_lock` is for — but it costs
        // nothing and removes one more way to lose the same race.
        // MAX_LOCAL_RESOURCE_TIMEOUT (5 s) is the largest value the builder accepts.
        .local_resource_timeout(arti_client::MAX_LOCAL_RESOURCE_TIMEOUT)
        .create_unbootstrapped()
}

/// Bind the SOCKS listener, publish the handle, and announce `connected`.
async fn finish_start(
    cfg: TorStartConfigJson,
    client: std::sync::Arc<TorClient<PreferredRuntime>>,
) -> i32 {
    // ── 4. Bind the SOCKS listener ───────────────────────────────────────────────────────────────
    let server = match socks::serve(std::sync::Arc::clone(&client), cfg.socks_port).await {
        Ok(s) => s,
        Err(e) => {
            emit("error", 0, "", 0, &format!("socks bind: {e}"));
            return codes::ERR_SOCKS_BIND;
        }
    };
    let port = server.port;

    // Honour a start that asked for dormancy up front, so a background start does not spin the
    // radio. `setActive` (dormancy.ts → StiqArti.setActive) lifts it.
    if cfg.dormancy {
        client.set_dormant(DormantMode::Soft);
    }

    *handle_slot().lock().unwrap() = Some(Handle {
        client,
        socks: server,
        // Arti exposes no HTTP CONNECT proxy. -1 tells StiqWebProxy "reader mode only" rather than
        // letting it dial a port that does not exist.
        http_port: -1,
    });

    // ── 5. Only now is `connected` true ──────────────────────────────────────────────────────────
    emit("connected", 100, "Connected", port as i32, "");
    port as i32
}

/// Translate the JSON start config into a `TorClientConfig`.
///
/// The error carries the `codes::*` value to return, because a bad bridge/PT setup is a different
/// failure for the caller than a bad `dataDir`: the connect ladder retries the next rung on
/// `ERR_PT_UNSUPPORTED`, but a malformed config is not worth retrying at all.
fn build_config(cfg: &TorStartConfigJson) -> Result<arti_client::TorClientConfig, (i32, String)> {
    let bad = |m: String| (codes::ERR_BAD_CONFIG, format!("config: {m}"));

    let data_dir = cfg.data_dir.as_deref().ok_or_else(|| {
        bad("dataDir is required (Kotlin resolves it to getDir(\"ArtiState\", MODE_PRIVATE))".into())
    })?;

    // Arti wants these separated: `state` is durable (guards, persisted state) and `cache` is
    // disposable (consensus, descriptors). Keeping cache under the same app-private parent means
    // Android's "clear cache" cannot orphan the state half.
    let state_dir = std::path::Path::new(data_dir).join("state");
    let cache_dir = std::path::Path::new(data_dir).join("cache");

    // Create them, including `state/keystore`.
    //
    // On a desktop these come into being through the packaging or the user's first run; on Android
    // nothing pre-creates anything under getDir(), so the very first launch hands Arti three paths
    // that do not exist. `keystore` is called out explicitly because arti-client derives it as
    // `state_dir.join("keystore")` (client.rs create_keymgr) and opens it with
    // `ArtiNativeKeystore::from_path_and_mistrust`, which does not create it either — so a client
    // that constructs fine still fails the moment a restricted-discovery key is inserted.
    for dir in [&state_dir, &cache_dir, &state_dir.join("keystore")] {
        std::fs::create_dir_all(dir)
            .map_err(|e| bad(format!("could not create {}: {e}", dir.display())))?;
    }

    let mut builder = TorClientConfigBuilder::from_directories(&state_dir, &cache_dir);

    // Turn OFF the filesystem-permission checks.
    //
    // fs-mistrust exists to stop another user on a shared machine from tampering with Arti's state.
    // Android has no other user: the app's data dir is owned by a per-app UID inside the sandbox,
    // and that is a stronger guarantee than the mode-bit check. What mistrust *does* do here is walk
    // the ancestors of /data/user/0/<pkg>/… — paths the app does not own and cannot chmod — and
    // refuse to start. This is the same call Orbot and the Guardian Project's arti builds make.
    builder.storage().permissions().dangerously_trust_everyone();

    // State the onion policy rather than inheriting it. arti-client defaults `allow_onion_addrs` to
    // true; at 0.28 `StreamPrefs::connect_to_onion_services` documented the opposite and the crate
    // contradicted itself. 0.44 fixed the doc, not the default — but STIQ can talk to nothing but
    // onions, so this stays explicit rather than tracking a doc that has already been wrong once.
    builder.address_filter().allow_onion_addrs(true);

    // Same reasoning for the keystore, which is where the restricted-discovery credentials live.
    // `ArtiKeystoreConfig::is_enabled()` defaults to `cfg!(feature = "keymgr")`, i.e. it depends on
    // how this crate happens to be compiled. Members-only reach must not hinge on a feature flag
    // several crates away, so say it outright: without the keystore,
    // `insert_service_discovery_key` fails with `KeystoreRequired` and no community is reachable.
    builder
        .storage()
        .keystore()
        .enabled(BoolOrAuto::Explicit(true));

    // Floor the LEARNED circuit-build timeout at 10 seconds (cbtmintimeout is in milliseconds).
    //
    // ROOT CAUSE OF THE 2026-07-28 FIELD OUTAGE (empty spaces, failed token draws, dead relay WS
    // while "connected"): arti's Pareto circuit-build-timeout estimator activates after 100
    // observed builds (`cbtmincircs`) and then times builds out at the learned 80th percentile,
    // clamped only by `cbt_min_timeout` — whose arti default is 10 MILLISECONDS (tor-netdir
    // params.rs; C-tor's effective client floor is 1500ms). This app's workload is pathological
    // for that estimator: every stream is deliberately circuit-isolated (socks.rs), so a session
    // observes hundreds of builds, most of them fast 3-hop builds on a good network — which
    // teaches a sub-second timeout. Onion-service work (HsDir fetch, intro, rendezvous — the ONLY
    // thing this app does) then trips it wholesale: hspool logs "Unable to build preemptive
    // circuit … Circuit took too long to build", every hs conn fails with "Failed to obtain …
    // circuit", and the relay onion becomes unreachable on a healthy network, while bootstrap
    // still reports 100%. Captured on-device 2026-07-28 with tor_circmgr/tor_hsclient at debug.
    //
    // The clamp is applied at read time (pareto.rs `timeouts()`: `max(computed, min_timeout)`),
    // so this heals an already-poisoned persisted estimator state without wiping it. Learning
    // stays ON — a genuinely slow network can still adapt UPWARD past the floor; the floor only
    // forbids learning DOWN into values that real-world mobile builds routinely exceed. The
    // consensus does not currently set cbtmintimeout, but override_net_params would win even if
    // it did — deliberate: no consensus value can re-open this failure mode.
    builder
        .override_net_params()
        .insert("cbtmintimeout".to_owned(), 10_000);

    // Bridges + the managed PT process. A no-op for `direct`, so the fast path pays nothing.
    pt::configure(
        &mut builder,
        &cfg.transport,
        &cfg.bridge_lines,
        cfg.native_lib_dir.as_deref(),
    )
    .map_err(|m| (codes::ERR_PT_UNSUPPORTED, format!("transport: {m}")))?;

    builder.build().map_err(|e| bad(e.to_string()))
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

/// Stop the daemon: shut the SOCKS server down, drop the TorClient, then emit `stopped`.
///
/// Order matters, and so does the fact that this BLOCKS until teardown is done.
///
/// The SOCKS shutdown has to complete first, because every connection task holds its own
/// `TorClient` clone — dropping only the copy stored here would leave live circuits carrying
/// traffic after this function returned, and would leave `state/state.lock` held. The caller's next
/// act is almost always to start a new client on the same state directory (the connect ladder does
/// exactly that between rungs), and that client cannot take the lock while any clone survives.
///
/// Runs inside the tokio runtime because the drain is async. `block_on` is safe here: this is only
/// ever reached from the JNI thread (`Java_..._artiStop`), never from inside the runtime itself,
/// where it would panic.
pub fn arti_stop() {
    /// Ceiling on BOTH graceful teardown steps COMBINED — draining the SOCKS server's live
    /// connections, then waiting for arti's own stop signal — as ONE shared deadline, not two
    /// budgets run in series.
    ///
    /// Before this, `SocksServer::shutdown` ran its own 3s drain budget to completion and THEN
    /// the wait for `wait_for_stop` got a fresh budget on top of that, so a wedged stop paid both
    /// in full before ever reaching `shutdown_runtime`'s hard-abort budget below — three budgets
    /// in series, additive to ~8s worst case for what these comments call "a preset switch the
    /// user is watching". A single deadline shared by both steps (via `timeout_at`, not
    /// `timeout`) means the SECOND step only ever gets whatever time the FIRST one left, so the
    /// graceful phase as a whole cannot exceed this constant no matter how it splits between them.
    ///
    /// Still generous next to the milliseconds a clean stop actually needs (both steps finish
    /// near-instantly then) — this budget exists for the pathological case, not the common one.
    const GRACEFUL_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

    let taken = handle_slot().lock().unwrap().take();
    let rt = rt_slot().lock().unwrap().take();
    if let Some(rt) = rt {
        if let Some(h) = taken {
            rt.block_on(async move {
                let deadline = tokio::time::Instant::now() + GRACEFUL_BUDGET;

                // 1. Drain the SOCKS server. Until every connection task is gone, clones of the
                //    client survive and step 3 can never complete. Bounded by the SAME deadline
                //    step 2 uses below — see GRACEFUL_BUDGET — not a budget of its own.
                if tokio::time::timeout_at(deadline, h.socks.shutdown())
                    .await
                    .is_err()
                {
                    #[cfg(target_os = "android")]
                    log::warn!(
                        "socks drain unfinished within the graceful budget; proceeding to wait \
                         for arti's own stop signal with whatever budget remains"
                    );
                }

                // 2. Take the stop signal BEFORE dropping the client — it is a method on it.
                //    `wait_for_stop` resolves when the state manager unlocks. NOTE: measurement has
                //    since shown that is a best-effort hint, not a promise — it resolved in 845ms on
                //    a stop whose lock was still held 30s later, because arti's spawned dirmgr /
                //    chanmgr tasks hold the state manager and a dropped client does not abort them.
                //    It is still worth awaiting: on a clean stop it IS the fast path, and it lets
                //    the common case finish in milliseconds instead of waiting on a timeout.
                let stopped = h.client.wait_for_stop();

                // 3. Drop the client; arti has no explicit shutdown, and the last clone dropping is
                //    what tears the reactor down.
                drop(h.client);

                // Bounded by whatever is LEFT of `deadline`, not a fresh budget of its own: if step
                // 1 used the whole graceful window this returns immediately, straight through to
                // the hard abort below.
                if tokio::time::timeout_at(deadline, stopped).await.is_err() {
                    #[cfg(target_os = "android")]
                    log::warn!(
                        "graceful drain unfinished after {GRACEFUL_BUDGET:?}; aborting remaining tasks"
                    );
                }
            });
        }

        // The hard guarantee, and the reason bridges work at all across a restart. Whatever the
        // drain above did or did not finish, this ABORTS every task arti still has running —
        // including the dirmgr/chanmgr retry loops that, against unreachable bridges, would
        // otherwise hold state/state.lock indefinitely and make every subsequent start die on
        // "operation not implemented: Error setting up the guard manager".
        shutdown_runtime(rt);
    }
    // The runtime shutdown above aborted any in-flight verification with everything else, so the
    // gate can be re-armed for the next lifecycle without racing a stale probe.
    verify_gate().store(false, std::sync::atomic::Ordering::SeqCst);
    emit("stopped", 0, "", 0, "");
}

/// Suspend or resume background activity — the Arti side of `dormancy.ts`.
///
/// C-tor's `DormantClientTimeout` has no Arti equivalent; `DormantMode::Soft` is the analog, and it
/// is stronger than a timeout because it takes effect immediately rather than after an idle period.
/// Any use of the client wakes it back up on its own, so this is safe to leave set.
pub fn arti_set_dormant(dormant: bool) {
    if let Some(h) = handle_slot().lock().unwrap().as_ref() {
        h.client.set_dormant(if dormant {
            DormantMode::Soft
        } else {
            DormantMode::Normal
        });
    }
}

/// Rotate identity — the Arti side of `App.tsx → requestNewTorCircuit`.
///
/// Arti has **no global NEWNYM**, so this is not a like-for-like of the C-tor signal, and the
/// difference is worth being precise about:
///
///   * What this does do is retire the onion circuit pool, forcing every subsequent `.onion`
///     connection to build a fresh rendezvous circuit. For STIQ that covers essentially all
///     traffic, because every destination the app has is an onion.
///   * What it cannot do is disturb streams that are already open. C-tor's NEWNYM does not either
///     (it only affects new streams), so the semantics actually line up.
///   * Exit circuits are untouched. STIQ builds none.
///
/// Independently of this call, each SOCKS session already gets its own circuit via the credential
/// isolation in socks.rs, so identity separation does not depend on NEWNYM the way it would in a
/// browser.
pub fn arti_new_identity() {
    if let Some(h) = handle_slot().lock().unwrap().as_ref() {
        // `hs_circ_pool()` returns a `Result` as of arti-client 0.44 (it was infallible at 0.28):
        // it now fails rather than panicking when the client has no HS circuit pool. Swallow it the
        // same way the old `let _ =` swallowed the retire failure — a new identity that cannot
        // retire the pool must not take the daemon down, and there is nothing the caller can do.
        if let Ok(pool) = h.client.hs_circ_pool() {
            let _ = pool.retire_all_circuits();
        }
    }
}

/// Send Arti's `log` output to logcat, so failures inside the 519-crate graph are visible at all.
///
/// `init_once` is idempotent, which is why `artiRegisterCallback` can call it unconditionally.
#[cfg(target_os = "android")]
pub fn arti_init_logging() {
    android_logger::init_once(
        android_logger::Config::default()
            // INFO, deliberately — do not raise this to DEBUG in a shipping build.
            //
            // Arti's DEBUG tracing dumps FULL bridge lines (including the obfs4 cert), guard
            // identities and per-circuit detail into logcat. For an app whose whole point is that
            // an observer cannot learn how its users reach the network, that is an
            // information-disclosure regression, not just noise.
            //
            // INFO is where the genuinely useful diagnostics live anyway: tor_ptmgr's
            // "Successfully launched PT for <transport> at PtClientMethod{…}" — the line that
            // proves the pluggable-transport handshake completed — is emitted at INFO.
            //
            // When a circuit-path capture is needed again, swap in — LOCAL DIAGNOSTIC BUILDS ONLY
            // (this is how the 2026-07-28 CBT field outage was root-caused; the filter also drags
            // env_filter into the .so, ~+400 KB):
            //   .with_max_level(log::LevelFilter::Debug)
            //   .with_filter(android_logger::FilterBuilder::new()
            //       .parse("info,tor_circmgr=debug,tor_hsclient=debug,tor_guardmgr=debug").build())
            .with_max_level(log::LevelFilter::Info)
            .with_tag("StiqArti"),
    );
}

// The exported symbols live in `jni_bridge.rs`. Everything above is plain Rust on purpose: the
// functions here are the daemon's behaviour and are worth reading and testing on their own, while
// the JNI layer is pure marshalling. Keeping them apart means a signature change on the Java side
// cannot quietly alter what the daemon does.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_measured_guard_failure_kills_the_rung() {
        // THE case this whole probe exists for. `tor-guardmgr`'s `PickGuardError::AllGuardsDown` —
        // "No usable guards. Rejected 27/29 as down, then 0/2 as pending, then 2/2 as unsuitable" —
        // maps to TorAccessFailed. On 2026-07-27 the daemon emitted `connected` 12ms after that
        // line. If this assertion ever flips, the ladder parks on dead bridges again.
        assert!(transport_is_dead(ErrorKind::TorAccessFailed));
    }

    #[test]
    fn no_circuit_could_be_built_escalates_the_ladder() {
        for kind in [
            ErrorKind::TorAccessFailed,
            ErrorKind::NoPath,
            ErrorKind::NoExit,
            ErrorKind::TorDirectoryUnusable,
            ErrorKind::DirectoryExpired,
            ErrorKind::BootstrapRequired,
            ErrorKind::TorNetworkTimeout,
            ErrorKind::ExternalToolFailed,
        ] {
            assert!(
                transport_is_dead(kind),
                "{kind:?} means no circuit was built; the rung must fail so the ladder moves on"
            );
        }
    }

    #[test]
    fn our_own_relay_being_down_must_never_cycle_the_ladder() {
        // Each of these was DISCOVERED over a working circuit, so the transport is proven good.
        // Failing the rung on any of them would take the app fully offline — every transport
        // failing identically — for the duration of a routine relay restart.
        for kind in [
            ErrorKind::OnionServiceNotFound,
            ErrorKind::OnionServiceNotRunning,
            ErrorKind::OnionServiceProtocolViolation,
            ErrorKind::OnionServiceConnectionFailed,
            ErrorKind::OnionServiceAddressInvalid,
            ErrorKind::RemoteConnectionRefused,
            ErrorKind::RemoteNetworkTimeout,
            ErrorKind::RemoteNetworkFailed,
            ErrorKind::RemoteHostNotFound,
            ErrorKind::RemoteHostResolutionFailed,
            ErrorKind::RemoteStreamClosed,
            ErrorKind::RemoteStreamReset,
            ErrorKind::RemoteStreamError,
            ErrorKind::RemoteProtocolViolation,
            ErrorKind::ExitPolicyRejected,
            ErrorKind::ExitTimeout,
            ErrorKind::CircuitCollapse,
            ErrorKind::RelayTooBusy,
        ] {
            assert!(
                !transport_is_dead(kind),
                "{kind:?} would cycle the whole ladder over a relay outage"
            );
        }
    }

    #[test]
    fn a_bad_client_auth_credential_is_not_a_transport_problem() {
        // No transport can fix a missing or stale reach credential. socks.rs already maps these to
        // the 0xF4/0xF5 SOCKS replies SocksReply.kt treats as permanent, which is where the
        // user-facing diagnosis belongs — not in a ladder that would retry them on every rung.
        assert!(!transport_is_dead(ErrorKind::OnionServiceMissingClientAuth));
        assert!(!transport_is_dead(ErrorKind::OnionServiceWrongClientAuth));
    }

    #[test]
    fn an_unclassified_kind_keeps_the_rung() {
        // `ErrorKind` is #[non_exhaustive], so a variant a future arti adds lands on the `_` arm.
        // That arm must fall on the lenient side: an unrecognised failure is not evidence that the
        // TRANSPORT is at fault, and treating it as such is the one way this probe could make the
        // app worse than it was before the probe existed.
        for kind in [
            ErrorKind::Internal,
            ErrorKind::BadApiUsage,
            ErrorKind::Other,
            ErrorKind::KeystoreAccessFailed,
            ErrorKind::FsPermissions,
            ErrorKind::InvalidConfig,
            ErrorKind::LocalResourceAlreadyInUse,
            ErrorKind::TransientFailure,
        ] {
            assert!(
                !transport_is_dead(kind),
                "{kind:?} is not a transport fault; failing the rung would cycle the ladder forever"
            );
        }
    }

    #[test]
    fn the_probe_dials_the_port_the_app_dials() {
        // StiqSocketModule.socks5Connect: `val port = if (uri.port > 0) uri.port else 80`, and
        // STIQ's relay URLs are ws://<host>.onion with no explicit port. Probing a different port
        // would report "service down" on a healthy path.
        assert_eq!(PROBE_PORT, 80);
    }

    // ── Opt-in, real-network, on-device integration ──────────────────────────────────────────────
    //
    // Everything above is a pure function. These two are the opposite: they run the ACTUAL
    // `arti_start` against the ACTUAL Tor network on a real handset, which is the only place the
    // probe's behaviour can honestly be observed — a mocked circuit cannot fail to be built the way
    // dead bridges fail to be built.
    //
    // They are `#[ignore]`d and additionally gated on environment variables, for three reasons:
    //   * they dial the live Tor network, so they must never run as part of a routine sweep;
    //   * they take tens of seconds;
    //   * the relay onion is DEPLOYMENT-SPECIFIC. It is read from `STIQ_PROBE_ONION` rather than
    //     hardcoded, so this file carries no operator-identifying string (see the sanitizer table in
    //     scripts/export-public.ps1 — a hostname committed here would be one more thing that must
    //     never be missed).
    //
    // Run them on device with:
    //
    //   cargo test --target aarch64-linux-android --no-run
    //   adb push <test binary> /data/local/tmp/arti_test && adb shell chmod 755 /data/local/tmp/arti_test
    //   adb shell STIQ_PROBE_ONION=<56-char host, no .onion> STIQ_PROBE_PT_DIR=/data/local/tmp/pt \
    //             /data/local/tmp/arti_test --ignored --test-threads=1 --nocapture
    //
    // `STIQ_PROBE_PT_DIR` must hold an executable `libLyrebird.so` (push it out of
    // android/app/src/main/jniLibs/arm64-v8a/ and chmod 755 — /data/local/tmp is exec-capable for
    // the shell user, app-private storage is not).

    /// Records every event the daemon emits so a test can assert on what the app WOULD have seen.
    struct Recorder(std::sync::Arc<Mutex<Vec<(String, String)>>>);

    impl ArtiBootstrap for Recorder {
        fn on_event(&self, kind: String, _p: i32, _s: String, _port: i32, message: String) {
            self.0.lock().unwrap().push((kind, message));
        }
    }

    /// Install a fresh recorder and hand back the log it writes to.
    ///
    /// Also turns on the logcat bridge, because the recorder alone cannot tell the two SUCCESSFUL
    /// outcomes apart: `Probe::Reachable` and `Probe::ServiceUnreachable` both end in `connected`,
    /// by design. Only the log line says which happened, and "the probe actually reached the relay"
    /// is a materially stronger result than "the probe declined to fail the rung".
    fn record() -> std::sync::Arc<Mutex<Vec<(String, String)>>> {
        #[cfg(target_os = "android")]
        arti_init_logging();
        let log = std::sync::Arc::new(Mutex::new(Vec::new()));
        arti_set_callback(Box::new(Recorder(std::sync::Arc::clone(&log))));
        log
    }

    /// ONE scratch data dir shared by both cases, exactly as the app shares one `app_ArtiState`
    /// across every rung of its connect ladder.
    ///
    /// Sharing it is not laziness, it is the precondition for the bug. MEASURED while writing these
    /// tests: with a VIRGIN directory the obfs4 case never even reaches the probe — `client.bootstrap()`
    /// simply never returns, because there is no cached consensus and no bridge through which to
    /// fetch one, so it retries forever (nothing on the Rust side bounds that; only App.tsx's
    /// no-progress deadline does). The false `connected` this probe exists to prevent can ONLY happen
    /// once a usable consensus is already on disk — that is the whole mechanism: "bootstrap complete"
    /// means "the directory is usable", and a cached directory satisfies it with no working channel.
    fn scratch() -> String {
        let dir = std::path::Path::new("/data/local/tmp/arti-probe-test/state");
        std::fs::create_dir_all(dir).expect("scratch dir");
        dir.to_string_lossy().into_owned()
    }

    /// Config JSON for one start. `bridges`/`pt_dir` are empty for the direct case.
    fn start_config(transport: &str, bridges: &str, pt_dir: Option<&str>, onion: &str) -> String {
        let pt = pt_dir.map(|d| format!(r#""nativeLibDir":"{d}","#)).unwrap_or_default();
        let key = std::env::var("STIQ_PROBE_KEY").unwrap_or_else(|_| "A".repeat(52));
        format!(
            r#"{{"transport":"{transport}","bridgeLines":[{bridges}],"socksPort":0,
                 "dataDir":"{}",{pt}
                 "onionAuth":{{"onionHost":"{onion}","privKeyBase32":"{key}"}},"dormancy":false}}"#,
            scratch(),
        )
    }

    fn onion_from_env() -> Option<String> {
        std::env::var("STIQ_PROBE_ONION").ok().filter(|h| !h.is_empty())
    }

    /// B — THE REGRESSION GUARD. A working direct-Tor path must still reach `connected`.
    ///
    /// Failing a healthy rung would be far worse than the bug being fixed here, so this is the
    /// assertion that matters most: `arti_start` must return a bound SOCKS port, and the app must
    /// have seen `connected` and no `error`.
    #[test]
    #[ignore = "dials the live Tor network; run explicitly on a device"]
    fn direct_tor_still_connects_with_the_probe_in_the_path() {
        let Some(onion) = onion_from_env() else {
            eprintln!("STIQ_PROBE_ONION unset — skipping");
            return;
        };
        let log = record();
        let rc = arti_start(start_config("direct", "", None, &onion));
        let events = log.lock().unwrap().clone();
        arti_stop();

        println!("direct rc={rc} events={events:?}");
        assert!(
            rc > 0,
            "direct Tor must still start; got {rc} and {events:?}"
        );
        assert!(
            events.iter().any(|(k, _)| k == "connected"),
            "direct Tor must still emit connected; saw {events:?}"
        );
    }

    /// A — THE BUG. obfs4 over bridges that cannot be reached must NOT report success.
    ///
    /// Before the probe this returned a bound SOCKS port and emitted `connected` ~12ms after
    /// tor-guardmgr logged "No usable guards", which is what parked App.tsx's ladder on a dead rung.
    #[test]
    #[ignore = "dials the live Tor network; run explicitly on a device"]
    fn unreachable_bridges_fail_the_start_instead_of_reporting_connected() {
        let Some(onion) = onion_from_env() else {
            eprintln!("STIQ_PROBE_ONION unset — skipping");
            return;
        };
        let Ok(pt_dir) = std::env::var("STIQ_PROBE_PT_DIR") else {
            eprintln!("STIQ_PROBE_PT_DIR unset — skipping");
            return;
        };
        // Deliberately unroutable bridge addresses (RFC 5737 TEST-NET-1). Using the app's real
        // bundled set would make this test's verdict depend on whether those bridges happen to be
        // up today; these can never answer, which is exactly the condition under test.
        let bridges = r#""obfs4 192.0.2.1:443 011F2599C0E9B27EE74B353155E244813763C3E5 cert=ayq0XzCwhpdysn5o0EyDUbmSOx3X/oTEbzDMvczHOdBJKlvIdHHLJGkZARtT4dcBFArPPg iat-mode=0",
                          "obfs4 192.0.2.2:80 10A6CD36A537FCE513A322361547444B393989F0 cert=K1gDtDAIcUfeLqbstggjIw2rtgIKqdIhUlHp82XRqNSq/mtAjp1BIC9vHKJ2FAEpGssTPw iat-mode=0""#;

        // SEED THE CACHE FIRST. See `scratch()`: with no consensus on disk this case never reaches
        // the probe at all, it just sits in `bootstrap()` forever. One direct start puts a usable
        // directory in the shared state dir, which is the state a real phone is always in by the
        // time the ladder escalates to a bridge rung — and the state in which bootstrap lies.
        if !std::path::Path::new(&scratch()).join("cache").exists() {
            let _ = record();
            let seed = arti_start(start_config("direct", "", None, &onion));
            arti_stop();
            assert!(seed > 0, "could not seed a warm directory cache; got {seed}");
        }

        let log = record();
        let rc = arti_start(start_config("obfs4", bridges, Some(&pt_dir), &onion));
        let events = log.lock().unwrap().clone();
        arti_stop();

        println!("obfs4 rc={rc} events={events:?}");
        assert!(
            !events.iter().any(|(k, _)| k == "connected"),
            "a rung that cannot carry a stream must never report connected; saw {events:?}"
        );
        assert!(
            events.iter().any(|(k, _)| k == "error"),
            "the ladder only escalates on an error event; saw {events:?}"
        );
        assert_eq!(rc, codes::ERR_NO_CIRCUIT, "wrong failure code for a dead rung");

        // ── And now the part that makes failing the rung SAFE ────────────────────────────────────
        //
        // Escalating is worthless if escalating is what breaks the next rung. A failed start still
        // spawned arti's dirmgr/chanmgr tasks, and against unreachable bridges those retry forever
        // while holding `state/state.lock` — after which every subsequent start dies on "operation
        // not implemented: Error setting up the guard manager" and the ladder cascades to nothing.
        // (Read `rt_slot()`'s doc comment; retrying harder was measured NOT to fix it.)
        //
        // The guarantee is that a failed start leaves `handle_slot` EMPTY, so `arti_start`'s tail
        // takes the `shutdown_runtime(rt)` branch and ABORTS those tasks. This asserts the guarantee
        // where it can actually be observed: the very next rung, on the same state directory.
        let next = record();
        let after = arti_start(start_config("direct", "", None, &onion));
        let next_events = next.lock().unwrap().clone();
        arti_stop();
        println!("rung after the failure rc={after}");
        assert!(
            after > 0,
            "the rung AFTER a failed one must still start (state lock leaked?); got {after} and \
             {next_events:?}"
        );
    }

    #[test]
    fn the_probe_deadline_stays_inside_the_js_one() {
        // App.tsx's cold ladder allows 120s of no forward progress per rung, and the
        // `bootstrapping 99%` line emitted just before the probe re-arms that clock. Staying well
        // under it is what stops a late `connected` arriving for an attempt JS already abandoned.
        assert!(PROBE_TIMEOUT < std::time::Duration::from_secs(120));
        assert!(PROBE_TIMEOUT >= std::time::Duration::from_secs(30));
    }

    #[test]
    fn no_path_retries_are_bounded_by_the_js_no_progress_deadline() {
        // The retry loop's TOTAL cost is NO_PATH_GRACE, not NO_PATH_GRACE + PROBE_TIMEOUT, because
        // each attempt's budget is `PROBE_TIMEOUT.min(remaining.max(1s))` — `remaining` shrinks to
        // the deadline, so a late attempt cannot outlive it. That clamp is load-bearing: without it
        // a final attempt could add a full PROBE_TIMEOUT on top and blow the JS budget.
        //
        // TorManager's DEFAULT_BOOTSTRAP_TIMEOUT_MS is 60s of NO FORWARD PROGRESS, and the probe
        // emits no progress while retrying, so the whole loop has to fit inside it with room to
        // spare. If either constant moves, this is the test that should stop it.
        const JS_NO_PROGRESS_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);
        assert!(
            NO_PATH_GRACE < JS_NO_PROGRESS_BUDGET,
            "the probe would outlive the JS deadline and `connected` would arrive for an attempt \
             App.tsx already abandoned"
        );
        // Enough headroom for the JS side to actually act on the failure, not just receive it.
        assert!(JS_NO_PROGRESS_BUDGET - NO_PATH_GRACE >= std::time::Duration::from_secs(15));

        // Long enough to be worth having: a PT handshake that lost its first attempt in ~30ms needs
        // real seconds, not a token second retry.
        assert!(NO_PATH_GRACE >= std::time::Duration::from_secs(20));
        assert!(NO_PATH_RETRY_EVERY < NO_PATH_GRACE);
        // At least a handful of attempts, or the retry adds latency without adding chances.
        assert!(NO_PATH_GRACE.as_secs() / NO_PATH_RETRY_EVERY.as_secs() >= 5);
    }
}
