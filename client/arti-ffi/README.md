# arti-ffi — STIQ T17 Arti-migration spike (Rust cdylib)

> **⚠ STATUS: SCAFFOLD, NOT BUILT.** This crate was written on a host with **no Rust
> cross-compile toolchain and no Android NDK**, so it has **never been compiled or linked**.
> Every `arti-client` / `tor-hsclient` API name in `src/*.rs` is marked `TODO(arti-api)` and is
> **provisional** until it resolves against a real `Cargo.lock`. What IS load-bearing and final is
> the **FFI shape** — the function signatures, the JSON config contract, and the event kinds — which
> the already-shipped, jest-green `ArtiTorBackend` (TS) and the `StiqArtiModule.kt` scaffold bind to.

This is the T17-S1 deliverable: a `cdylib` (`libarti_mobile.so`) wrapping `arti-client` behind a
stable start/stop/bootstrap FFI, emitting the **same** `TorBackendEvent` kinds
(`client/src/tor/types.ts`) the shipping C-tor path emits — so nothing above the `TorBackend` seam
changes when `USE_ARTI_BACKEND` selects it.

## Why Arti at all (the spike question)

The incumbent is `info.guardianproject:tor-android:0.4.8.22` (C-tor, in-process `tor_run_main()`) +
`com.netzarchitekten:IPtProxy:5.5.0` (in-process obfs4/snowflake/webtunnel). It works but carries
the whole `tor_run_main`-reentry / `hs_circuitmap` abort class of bugs the shipping
`StiqTorModule.kt` spends ~300 lines defending against (the `:tor` process isolation + teardown
barrier + forced-kill). Arti is pure-Rust, memory-safe, has **no** IPtProxy Controller-per-process
restriction, and drops-in behind the same seam. The spike asks whether it can cover STIQ's four
must-haves — **onion client connect, restricted-discovery client-auth, PT/obfs4, C-tor
key/state migration** — at an acceptable **.so size** on a low-end arm device.

## Files

| File | Role |
|---|---|
| `Cargo.toml` | crate = `arti-mobile`, `crate-type = ["cdylib"]`, pinned (provisional) deps, size-tuned release profile |
| `src/lib.rs` | lifecycle: one tokio runtime + one global client handle; `arti_start/arti_stop/arti_new_identity/arti_http_port` + bootstrap→`on_event` bridge |
| `src/ffi.rs` | the JSON config struct (mirrors `TorStartConfig`) + the `ArtiBootstrap` callback trait (kinds = `TorBackendEvent` kinds) |
| `src/onion_auth.rs` | **S4**: base32-decode + validate the x25519 restricted-discovery secret; install into Arti's KeyMgr (TODO) — fail-closed |
| `src/pt.rs` | **S5**: `direct`-only guard for the spike; bridge-line parser + the PT packaging finding |
| `build.sh` | **S1**: the `cargo ndk` cross-compile + strip + size recipe (documented, unrun) |
| `SIZE_REPORT.md` | produced by `build.sh` on a real run (not present until then) |

## FFI contract (final — do not drift)

Config is ONE JSON string mirroring `TorStartConfig` (see `src/ffi.rs::TorStartConfigJson`):

```json
{ "transport":"direct|webtunnel|obfs4|snowflake",
  "bridgeLines":["…"], "socksPort":0, "dataDir":"/abs/path",
  "onionAuth":{"onionHost":"<56b32>","privKeyBase32":"<52b32>"}|null,
  "onionAuthExtra":[{"onionHost":"…","privKeyBase32":"…"}], "dormancy":false }
```

Exports:

```
fn arti_start(config_json: String) -> i32   // bound SOCKS port > 0, or a negative codes::* value
fn arti_http_port() -> i32                  // HTTP CONNECT port, or -1 (WebView-proxy gap)
fn arti_stop()
fn arti_new_identity()
trait ArtiBootstrap { fn on_event(kind, percent, summary, socks_port, message) }
// kind ∈ starting | bootstrapping | connected | error | stopped  (== TorBackendEvent kinds)
```

`connected` is emitted **only after the SOCKS listener is accepting** — never before (an early
`connected` makes the relay WebSocket dial a not-yet-built circuit; this mirrors
`StiqTorModule.startControlSocketMonitor` firing at `PROGRESS=100`).

## Reproducing the build (on a toolchain host)

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi
cargo install cargo-ndk
export ANDROID_NDK_HOME=/path/to/Android/Sdk/ndk/<version>   # r26+
cd client/arti-ffi
./build.sh            # → android/app/src/arti/jniLibs/<abi>/libarti_mobile.so  + SIZE_REPORT.md
```

Then, BEFORE trusting the libs, run the host-target smoke (network-gated, `#[ignore]` by default):

```sh
cargo test --release -- --ignored connect_direct_onion
```

**After the first successful build, record here:** exact `rustc` version, NDK version, `cargo-ndk`
version, and the resolved `arti-client` / `tor-hsclient` versions from `Cargo.lock` (commit the
lockfile). Update every `TODO(arti-api)` in `src/*.rs` with the real type paths.

## FFI codegen choice

Two options; pick one on the toolchain host and delete the other path:

- **uniffi** (recommended for the callback ergonomics): annotate the `lib.rs` functions with
  `#[uniffi::export]` and let uniffi generate the JNI + the Kotlin `ArtiBootstrap` interface.
  Add `uniffi` as a build+runtime dep (commented in `Cargo.toml`).
- **plain `extern "C"`**: the `#[no_mangle] extern "C"` surface sketched at the bottom of `lib.rs`;
  the callback becomes an `extern "C" fn(*const c_char, i32, …)` + context pointer, and
  `StiqArtiModule.kt` loads `System.loadLibrary("arti_mobile")` and declares matching `external fun`s.

## Native registration (integrator TODO — deliberately NOT done)

`StiqArtiPackage` is **not** added to `MainApplication.kt` in this spike (keeping the branch inert
and isolated). To activate on the spike build, add `add(StiqArtiPackage())` to
`getPackages()` alongside `add(StiqTorPackage())`, drop the built `.so` under `jniLibs/`, and flip
`USE_ARTI_BACKEND = true` in `client/src/config.ts`. See the decision doc for the full flip-on
checklist.
