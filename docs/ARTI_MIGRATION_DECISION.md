# SUPERSEDED — 2026-07-27: Arti shipped; the 2026-07-11 NO-GO no longer holds

> **This document's verdict is SUPERSEDED.** Everything from the horizontal rule below onward is
> the original 2026-07-11 Go/No-Go analysis, preserved unmodified for history — read it for how
> that decision was reached, not for what is true today. What is true today is this section.

**Superseded by:** the branch that carries the Arti cutover (based on `master @ 0c94b787`).
**Not yet merged** — that is a decision for a human maintainer, not an agent.
**Superseded on:** 2026-07-27, revised same day as later device evidence landed on the same branch
— this section is the up-to-date reversal; it is not a third layer stacked on an earlier same-day
draft.

## Why the verdict flipped

The 2026-07-11 recommendation was **"GO on the seam, NO-GO on a cutover"** (§7 below), gated on
three blockers: (1) the pluggable-transport (PT) external-binary / W^X question — called out there
as *"the single biggest risk"* — (2) unmeasured `.so` size and cold-start, and (3) the WebView
HTTP-CONNECT gap. Blocker 1 is resolved, and resolved at the packaging level rather than worked
around. Blocker 2 is now measured on-device rather than estimated — but "measured" is not the same
as "favorable": size is a clear win, cold-start connect time is not (see §3–4 below). Blocker 3 is
**unchanged** —
still open today, and this document says so plainly rather than calling the migration
unconditional. Cutover has also happened in code: the incumbent Tor engine
(`info.guardianproject:tor-android` + IPtProxy) is deleted from the tree, not sitting dark behind a
flag next to Arti — there is no incumbent build left in this tree to A/B against.

### 1. Arti is the only Tor engine now

The spike's `USE_ARTI_BACKEND` flag does not exist anymore, in any form:
- `client/src/tor/index.ts`'s `createTorBackend()` unconditionally returns `ArtiTorBackend`,
  falling back only to an offline `UnavailableTorBackend` — never to the old engine, never to
  clearnet (`ALLOW_CLEARNET_FALLBACK` stays `false`).
- `StiqTorModule.kt` / `StiqTorPackage.kt` no longer exist under
  `client/android/app/src/main/java/com/stiq/client/`.
- `MainApplication.kt` (`getPackages()`) registers `add(StiqArtiPackage())` and contains no
  reference to the old module at all.
- `client/android/app/build.gradle`'s `dependencies {}` block no longer pulls
  `info.guardianproject:tor-android` or `com.netzarchitekten:IPtProxy` — the only remaining
  references are historical comments explaining what used to be there.

### 2. Blocker 1 (PT external-binary / W^X) is resolved — and the mechanism is the whole answer

The 2026-07-11 verdict flagged, correctly, that Arti's managed-PT path shells out to an external
lyrebird/obfs4 binary, and that executing a bundled binary from app-private storage collides with
Android's W^X hardening. That is exactly what would have happened on the naive path — and the fix
is a packaging decision, not a workaround:

- The PT binaries ship as real files under `client/android/app/src/main/jniLibs/<abi>/`
  (`libLyrebird.so` for obfs4/meek_lite, `libSnowflake.so`, `libWebtunnel.so`) alongside
  `libarti_mobile.so` itself. Because they live under `jniLibs`, the **installer** — not the app —
  extracts them into `nativeLibraryDir` at install time, which is the only exec-capable directory
  on API 29+ app storage. Nothing at runtime writes an executable to app-private storage; the
  binary the app later spawns was placed there by the OS's own package installer.
- That placement requires the libs to be extracted as real files rather than left mmap'd inside the
  APK's zip, which is exactly what `useLegacyPackaging = true`
  (`client/android/app/build.gradle`, `packaging { jniLibs { ... } }`, line 187) buys. The
  build.gradle comment is explicit that this used to be an unstated assumption whose failure mode
  is silent: *"the app would connect fine on the direct rung and quietly lose bridges"* — i.e. it
  would break only for users on a censored network, the users a bridge feature exists for.
- **Device-verified**, with the full managed-PT handshake actually driven by `tor-ptmgr` (not a
  standalone binary check) — captured on-device via a `tracing`→`log` bridge added specifically
  because Arti instruments with `tracing` and Android's logger only sees `log`:
  ```
  tor_ptmgr::ipc::sealed: Launching pluggable transport at .../lib/arm64/libSnowflake.so
  tor_ptmgr::ipc::sealed: Transport 'snowflake' uses method PtClientMethod { kind: V5, endpoint: 127.0.0.1:35085 }
  tor_ptmgr: Successfully launched PT for snowflake at PtClientMethod { ... }
  tor_chanmgr::factory: Attempting to open a new channel to [... via snowflake $8838...]
  ```
  Both `libLyrebird.so` (obfs4) and `libSnowflake.so` were separately confirmed running as real
  child processes of the app (process listing, parent PID = the app). This closes the "external
  binary = blocker" question for both transports actually launched; see §"Bridges" below for what
  is and is not proven beyond the launch itself.

### 3. Blocker 2 (`.so` size and cold-start) — measured, not estimated (size is a win; cold-start timing is not — see §4)

Every number in the 2026-07-11 doc's §6 was tagged `[MEASURE]` — there was no toolchain and no
device. That gate is closed, but the honest number today is bigger than an earlier same-day pass
reported, because that earlier pass measured a **direct-connect-only** build before the PT binaries
above were added back in. Quoting the current, checked numbers rather than that earlier one:

`client/arti-ffi/SIZE_REPORT.md` (generated by the crate's own `build.sh`, cross-checked against
the live `jniLibs` directory bit-for-bit):

| ABI | `libarti_mobile.so` (stripped) |
|---|---|
| arm64-v8a | 5,941,576 B (5.9 MB) |
| armeabi-v7a | 4,150,976 B (4.2 MB) |

That is the Tor engine alone. The full native footprint the app now ships also includes the three
PT binaries, measured directly from `client/android/app/src/main/jniLibs/`:

| File | arm64-v8a | armeabi-v7a |
|---|---|---|
| `libLyrebird.so` (obfs4/meek_lite) | 17,700,000 B | 16,869,892 B |
| `libSnowflake.so` | 17,243,360 B | 16,391,436 B |
| `libWebtunnel.so` | 5,381,408 B | 5,447,396 B |
| `libarti_mobile.so` | 5,941,576 B | 4,150,976 B |
| **Total, on disk** | **46,266,344 B (46.3 MB)** | **42,859,700 B (42.9 MB)** |

That total is uncompressed, on-disk bytes — not the number a user downloads. The tree also has a
built `app-arm64-v8a-release.apk`; checking its zip entries against the numbers above shows the
arm64 build is current to within 616 bytes on `libarti_mobile.so` (build-nondeterminism scale,
immaterial) and byte-identical on the three PT binaries, so its compressed sizes are trustworthy:

| File | Compressed in APK (arm64) | Ratio |
|---|---|---|
| `libLyrebird.so` | 6,195,312 B | 65% |
| `libSnowflake.so` | 6,037,972 B | 65% |
| `libWebtunnel.so` | 2,104,687 B | 61% |
| `libarti_mobile.so` | 3,168,646 B | 47% |
| **Total download cost, arm64** | **~17.5 MB** | — |

The **armeabi-v7a** build in the tree is measurably **stale** and is deliberately not quoted here:
its bundled `libarti_mobile.so` is 3,956,868 B in the built APK versus 4,150,976 B in the current
`jniLibs` — a 194 KB gap that can only mean the APK predates the armv7 rebuild recorded in this
branch's own working notes. Rebuild before citing an exact armv7 download number.

There is no incumbent (`tor-android` + IPtProxy) build left in this tree to diff against — it was
removed as part of the cutover (§1) — so a true side-by-side delta cannot be produced honestly from
this tree. ~17.5 MB of compressed download for Tor + all three pluggable transports, on a sideload-
over-Tor app where download bytes are the scarce resource, is the number to weigh, not a delta
against a build that no longer exists here.

That closes the **size** half of this blocker cleanly. The **cold-start** half does not close the
same way: see §4 below for the measured ~100 s cold-directory-cache connect time, which is the
actual "migration cost" the 2026-07-11 doc's §6 asked to have measured, and which is not a win.

### 4. Connect time — measured on device, and it is NOT a clean win

| Path | Result |
|---|---|
| Arti, warm connect (bridges known-good, Arti's own directory cache still valid) | **3.5 s** |
| Arti, direct connect (separate measurement pass) | 2.8 s |
| Arti, obfs4-bridge connect, network bootstrap only (separate pass) | 2.2 s |
| **Arti, cold directory cache (fresh install / cleared data)** | **~100 s**, flat 15% the whole time |
| Old engine (`tor-android`), same class of path | **30–90 s**, documented prior to removal |

The 3.5/2.8/2.2 s figures are all **warm-cache** numbers — "warm" here means the bridge set is
known-good, not that Arti's own on-disk directory cache is valid. When that cache is cold, Arti
pays the same cold-consensus fetch as a fresh start, which **measured ~100 s on a real device**
while Arti's percent stream (`conn*0.15 + dir*0.85`) sat at a **flat 15%** the entire time — no
intermediate progress to distinguish "working" from "stuck." This is documented in this same-day
tree at `client/App.tsx:668-676` (the comment justifying `WARM_BOOTSTRAP_TIMEOUT_MS = 120_000`)
and independently in `HANDOFF_BEAT_BITCHAT_2026-07-27.md:328` ("a cold user sees '15%' for ~100 s").

**A cold directory cache is not an edge case — it is what every first-time install and every
cleared-data user hits**, which is the exact audience a "beats bitchat" migration is aimed at. Set
against the incumbent's documented 30–90 s cold range, Arti's ~100 s cold figure is **comparable to
or worse than** what it replaces; only the warm path is an unambiguous win. Comparing Arti's warm
3.5 s against C-tor's general 30–90 s range, as an earlier pass of this section did, compares two
different things. Both figures belong in this table; neither should be quoted alone.

These are three different measurement passes on the same device, not numbers restated. The bridge
figure (2.2 s) measures Arti successfully bootstrapping its directory and launching the PT over a
bridge; it does **not** by itself mean a working circuit to any particular destination was built
through that bridge — see "Bridges" below for the distinction, which mattered enough here to have
previously produced a false positive.

### 5. Blocker 3 (WebView HTTP-CONNECT) — unchanged, still open, and it never gated cutover

Checked directly against source, not carried forward from an old note: `arti_http_port()`
(`client/arti-ffi/src/lib.rs:849`) still unconditionally returns `-1` — the daemon handle's
`http_port` field is hardcoded to `-1` at construction (`lib.rs:770`) and nothing in this branch
sets it otherwise. The full-page WebView proxy (`StiqWebProxy`,
`client/src/browser/browserData.ts`) still has no HTTP-CONNECT port to bridge to. This is an
**accepted, still-open limitation**, not a fixed gap being reported as fixed. It was already scored
`major`, not `blocker`, in the original matrix (§3 below), and that scoring holds: real, unresolved,
and never what the 2026-07-11 NO-GO actually turned on.

## Bridges: what is proven, what is not, and what still needs a human decision

This is the part of the migration most at risk of being oversold, so it is stated precisely.

**Proven:** Arti's PT integration launches and drives pluggable transports correctly. Both
`libLyrebird.so` (obfs4) and `libSnowflake.so` were confirmed running as real child processes,
`tor-ptmgr` completed its managed-PT handshake with each, and Arti attempted to dial through the
negotiated SOCKS endpoint (log evidence, §2 above). `libWebtunnel.so` builds and is accepted by the
bridge-line parser but has not been exercised against `tor-ptmgr` on hardware.

**Not proven:** that any bridge connection actually reached its destination end-to-end, on this
backend or the one it replaced. On this branch's test network, **24 of 24** sampled published obfs4
bridge endpoints were unreachable — `EHOSTUNREACH` in roughly 4 ms, which is the signature of active
filtering rather than of the bridges being merely down — while, on the same device at the same
moment, clearnet HTTP returned 200 and a direct (non-bridge) Tor connection succeeded in 1.4 s. That
is a property of the network the test ran on, not of Arti's PT handling. So: **Arti launches and
drives the PT correctly. Bridges are not proven to carry traffic end-to-end on any backend measured
here.** Neither claim should be read as covering the other.

A second, now-fixed bug had been compounding this diagnosis: Arti's bootstrap reported `connected
100%` a few milliseconds after its own circuit manager logged that it had no usable guard at all.
Reaching 100% only means the directory is usable, which a cached consensus satisfies with zero
working channels — so the app's connect ladder was treating a dead rung as success and never
escalating to its own moat-fetched-bridges fallback. The fix adds a post-bootstrap reachability
probe before emitting `connected`, with error-kind discrimination so a probe failure escalates the
ladder instead of hanging. See "Costs accepted" below for what that probe costs, because it is not
free.

**The real product answer for a censored community is a private bridge that has not been
enumerated by a censor** — published bridge lists are exactly what the 24/24 result shows getting
blocked. That is an **unmade decision**, not a code task, and it carries a trap worth stating
explicitly: **do not co-locate a private bridge with the relay.** A bridge necessarily advertises
its own IP to whoever it's handed to; the relay runs as an onion service specifically so its IP
stays hidden. Putting both roles on one host hands every user of that bridge an IP address that
also hosts the hidden service — the exact deanonymization the onion service exists to prevent.

## Costs accepted, and what is still open

Superseding the NO-GO is not the same as declaring the migration finished or free. These are real,
today:

- **The reachability probe (above) costs 12–18 s on a successful connect.** The user sits at "99%"
  for that window while the probe runs. This is the price of fixing the false-`connected` bug, not
  a separate regression, but it is a real, user-visible cost of doing the fix correctly.
- **A cold directory cache is slow even when nothing is broken: ~100 s, flat at 15%, for a
  first-time install or cleared-data user** (§4). That is a distinct case from the next bullet — a
  live rung with a genuinely cold cache eventually completes, it just costs two orders of magnitude
  more than the warm-cache number this document otherwise leads with.
- **On a cold directory cache, a dead rung never reaches the probe at all.** Arti's own
  `bootstrap()` call simply never returns in that case, and there is no Rust-side timeout wrapping
  it. This is a pre-existing gap, not introduced by the probe fix, and it is still open.
- **`compression` is still off.** `client/arti-ffi/Cargo.toml` builds `arti-client` with
  `default-features = false`, dropping `tor-dirclient`'s `xz`/`zstd` support, so Arti negotiates
  `deflate, identity` only. That is directory bytes paid on every cold bootstrap — still the single
  biggest lever left on connect time. This is a **host build-toolchain limitation** (the dev host's
  linker cannot produce the `dlltool.exe`-dependent host build products those features pull in), not
  an Android limitation, and re-enabling it has not been attempted in passing.
- **Onion-service client proof-of-work (prop327) is compiled in, but not proven under load.** The
  relay enables `HiddenServicePoWDefensesEnabled`. `client/arti-ffi/Cargo.toml` enables
  `arti-client`'s `hs-pow-full` feature specifically to answer that — the capability to solve a
  served Equi-X puzzle is compiled into the binary, a stronger position than the 2026-07-11 doc's
  "maturity is unclear." What is **not** established is behavior under an actually-loaded queue:
  prop327 *deprioritizes* rather than *rejects*, so an idle-relay test connect succeeds whether or
  not the client can solve the challenge at all. No test or device run exercises a loaded queue.
  Treat client-side PoW as **present in the binary, not verified in practice.**
- **`arti-client` is pinned well behind current upstream** (evaluated separately, not re-litigated
  here): no live CVE against the pinned version, and the newer release's onion-service-client
  connectivity fixes would apply to effectively all of this app's traffic. Deferred, not urgent.
- **The bundled default bridge list is stale** independent of the network-filtering finding above —
  at least some of its hosts refuse connections outright rather than merely being unreachable in
  this test's network.

## Bottom line

The 2026-07-11 gates are satisfied well enough to ship the engine swap, but not uniformly in Arti's
favor: the top blocker (PT/W^X) is fixed at the packaging level rather than worked around, `.so`
size is measured on real hardware and favorable, connect time is measured and **mixed** — warm
connects (3.5 s / 2.8 s / 2.2 s) beat the incumbent by an order of magnitude, but a cold directory
cache — what a fresh install or cleared-data user actually gets — measures **~100 s**, comparable
to or worse than the incumbent's own documented 30–90 s cold range (§4). The one blocker that
remains open (WebView HTTP-CONNECT) was never what the NO-GO hinged on. What is **not** claimed:
that connect time is an unambiguous win, that bridges work end-to-end for censored users on this
build, that the reachability-probe cost is free, or that a cold-cache hang is fixed. Those are
listed above as open, on purpose, because a supersede that only lists wins is not a decision
record — it is marketing wearing a decision record's clothes. This document's role changes
accordingly: it is no longer gating a decision that has not been made yet — it is the record of one
that has, kept below in full because a decision record that erases its own history is worthless.

---

## Original decision record — 2026-07-11 (superseded by the section above; preserved verbatim for history)

# ARTI MIGRATION — Go / No-Go Decision (T17 spike)

**Date:** 2026-07-11  ·  **Branch:** `claude/stiq-implementation-plan-20acdb` (worktree
`elegant-swirles-ce225b`)  ·  **Status:** SPIKE — dark, unmerged, `USE_ARTI_BACKEND = false`.

This document synthesizes the T17 Arti-migration spike (plan `STIQ_IMPLEMENTATION_PLAN_2026-07-10.md`,
§T17 lines 3084–3366) into one decision: should STIQ replace the shipping embedded-Tor backend
(`info.guardianproject:tor-android:0.4.8.22` C-tor + `com.netzarchitekten:IPtProxy:5.5.0`) with
**Arti** (the pure-Rust `arti-client`)? It consolidates the S1 (FFI/size), S4 (restricted discovery),
and S5 (PT + key migration) evaluation notes, plus the S3 TS-seam result, and the feature-gap matrix.

> ## ⚠ Honest scope caveat — read first
> The spike host had **no Rust cross-compile toolchain and no Android NDK**, and there is **no
> physical device in this environment**. Therefore:
> - **T17-S1** (`.so` build), **T17-S4/S5** (on-device onion-auth / PT / cold-start), and the
>   size/perf measurements **were scaffolded and documented, not RUN**. Every size and timing
>   figure below is an **UNMEASURED estimate** flagged `[MEASURE]`, and every `arti-client` API
>   name in `client/arti-ffi/src/*.rs` is `TODO(arti-api)` — provisional until it compiles.
> - **T17-S3** (the TS backend + flag + jest) **was implemented and VERIFIED**: `54/54` tor jest
>   tests green (`168/168` for the whole `src/tor/` suite), zero regression, zero wire change.
>
> So the **seam** is proven; the **native cutover** verdict is **BLOCKED on a real toolchain build +
> device measurement**. The recommendation (§7) reflects that split precisely.

> ### 🔧 Build re-attempt — 2026-07-11 (same branch, Windows dev host)
> The environment was **re-probed** and is materially better equipped than the original spike host —
> the blocker has been **narrowed to a single missing system dependency**:
>
> | Component | State on this host |
> |---|---|
> | `rustup` 1.29.0 · `rustc`/`cargo` 1.97.0 | ✅ present |
> | Rust Android std targets (`aarch64-`, `armv7-`, `x86_64-linux-android`) | ✅ installed this session |
> | Android NDK (`D:\Programs\ndk\26.1.10909125` + `27.2.12479018`), arm64 clang | ✅ present |
> | `go` 1.26.4, JDK17 (JBR), crates.io reachability | ✅ present |
> | **Host C/C++ linker — MSVC `link.exe` + Windows SDK (`kernel32.lib` …)** | ❌ **ABSENT** |
> | `cargo-ndk` | ❌ could not install (see below) |
>
> **Root cause (proven, not inferred):** a trivial `rustc` compile of `fn main(){}` fails with
> `error: linker 'link.exe' not found … the msvc targets depend on the msvc linker`. Because **every**
> `cargo build` — *including an Android cross-compile* — must compile the arti dependency tree's many
> **proc-macros and build-scripts for the HOST** (`x86_64-pc-windows-msvc`), and host linking needs
> MSVC `link.exe` + the Windows SDK import libs, **no Rust crate can be built on this host at all** until
> that linker is installed. `cargo install cargo-ndk` failed for the same reason (its own build scripts
> could not link; git-bash's GNU coreutils `/usr/bin/link.exe` shadowed the absent MSVC linker, yielding
> the misleading `link: extra operand` error). The NDK being present is **necessary but not sufficient**.
>
> **The single unblock step (one-time, elevated, ~2–6 GB):** install **Build Tools for Visual Studio 2022**
> with the **“Desktop development with C++”** workload (gives MSVC v143 `link.exe` + the Windows 11 SDK):
> ```
> winget install --id Microsoft.VisualStudio.2022.BuildTools --override ^
>   "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
> ```
> **Then the build is fully scriptable** (all other prerequisites are already in place):
> ```sh
> rustc "$(mktemp).rs" -o /dev/null  <<< 'fn main(){}'   # sanity: must now link
> cargo install cargo-ndk
> export ANDROID_NDK_HOME="D:/Programs/ndk/26.1.10909125"
> cd client/arti-ffi && ./build.sh          # emits libarti_mobile.so per ABI + SIZE_REPORT.md
> ```
> **Important build caveat discovered while reading the scaffold:** every `arti-client` call in
> `src/*.rs` is currently **commented out** (`TODO(arti-api)`), so a build of the crate *as-is* would
> dead-strip the Arti dependency and produce a **misleadingly tiny `.so`** — the size report would NOT
> reflect Arti's real footprint. Before trusting `SIZE_REPORT.md`, the `start_async` `TorClient` bootstrap
> + SOCKS bind (lib.rs §1–4) and `onion_auth::install_into_keymgr` (S4) must be **actually implemented**
> against the resolved crate so Arti code is reachable and linked. Sequence: install linker → resolve pins
> (`cargo build` → commit `Cargo.lock`) → implement the `TODO(arti-api)` call sites → **then** cross-compile
> and measure. The gates in §7 are unchanged; this note only makes the first gate’s single blocker precise.

---

## 1. What the spike delivered (and its build status)

| Subtask | Deliverable | Status |
|---|---|---|
| **S3** (TS) | `client/src/tor/artiBackend.ts` `ArtiTorBackend` + `getArtiTorModule()` | ✅ **built + jest-green** |
| **S3** (TS) | `createTorBackend()` flag branch in `client/src/tor/index.ts` (the ONE edit above the seam) | ✅ **built + jest-green** |
| **S3** (TS) | `client/src/tor/artiBackend.test.ts`, `index.test.ts` (flag matrix, safe-degrade, event mapping) | ✅ **12 tests pass** |
| **S4** (TS) | `client/src/tor/onionAuthArti.ts` pure mapper + `onionAuthArti.test.ts` | ✅ **built + jest-green** |
| **S1** (Rust) | `client/arti-ffi/` — `Cargo.toml`, `src/{lib,ffi,onion_auth,pt}.rs`, `build.sh`, `README.md` | ⚠ **scaffold, NOT compiled** |
| **S2** (Kotlin) | `StiqArtiModule.kt` + `StiqArtiPackage.kt` (mirror StiqTor; NOT registered in MainApplication) | ⚠ **scaffold, NOT compiled** |
| **S4** (Rust) | `arti-ffi/src/onion_auth.rs` base32 decode/validate + KeyMgr install (TODO) | ⚠ **scaffold, NOT compiled** |
| **S5** (Rust) | `arti-ffi/src/pt.rs` direct-only guard + bridge-line parser | ⚠ **scaffold, NOT compiled** |

**Isolation honored:** `config.ts` was **not** edited (the flag was already present at
`config.ts:140`). `App.tsx` was **not** touched. `StiqArtiPackage` is **not** registered in
`MainApplication.kt`. The single control-flow change is the flag branch in `tor/index.ts`, exactly
as the plan prescribes ("the ONLY control-flow edit above the seam").

---

## 2. The seam result (S3) — the one thing that is proven

`ArtiTorBackend` is a structural twin of `NativeTorBackend` (`nativeBackend.ts`): same `TorBackend`
interface (`start/stop/subscribe`), same `'StiqTorStatus'` event name, same `TorBackendEvent` union.
The jest suite proves the central "no wire change" claim end-to-end:

- A scripted `starting → bootstrapping → connected` sequence emitted over `'StiqTorStatus'` drives a
  **real `TorManager`** to `ConnectionState 'connected'` with the SOCKS proxy exposed — i.e. Arti
  presents the identical contract, so `TorManager.eventToState`, `connection.ts`, the App.tsx
  cascade, `torSocket.ts`, and the UI stay byte-identical.
- **Flag-selection matrix** (`index.test.ts`): flag OFF → byte-identical to today
  (`NativeTorBackend`/`UnavailableTorBackend`); flag ON + `StiqArti` present → `ArtiTorBackend`;
  flag ON + `StiqArti` **absent** → `UnavailableTorBackend` (**offline, NEVER clearnet** — the
  `ALLOW_CLEARNET_FALLBACK=false` invariant holds on the safe-degrade path).
- An Arti `error` event maps to `offline` with a null SOCKS proxy (no clearnet fallback).

**Verification run:** `npx jest src/tor/` → **14 suites, 168 tests, all pass**. New files
contribute 17 tests (artiBackend 6, index 5, onionAuthArti 4 + 2 host-shape asserts inline).

---

## 3. Feature-gap matrix

Severity: **blocker** (cutover impossible) · **major** (needs real work before cutover) ·
**minor** (small follow-up) · **none**. "Arti status" reflects the pinned-version intent; anything
un-measurable on this host is marked `[MEASURE]` / `[VERIFY]`.

| Feature | Incumbent (C-tor + IPtProxy) | Arti status | Gap severity | Effort to close |
|---|---|---|---|---|
| **Onion client connect** (relay onion via SOCKS) | ✅ tor-android in-process | ✅ `arti-client` feat `onion-service-client` (stable since Arti 1.2.0) `[VERIFY on device]` | **none** (pending device proof) | S1+S2 device smoke |
| **Restricted-discovery client-auth** (community x25519 reach key, lever 2) | ✅ `ClientOnionAuthDir` `<host>.auth_private` | ✅ install x25519 secret into KeyMgr, keyed by `.onion` `[VERIFY API + hot-add]` | **minor–major** (API pin + hot-add unknown) | S4 KeyMgr install + device connect-with/without-key |
| **PT — obfs4** | ✅ **in-process** (IPtProxy/lyrebird) | ⚠ `tor-ptmgr` + **likely EXTERNAL lyrebird/obfs4 binary** | **major/blocker** (W^X exec-from-app-dir on Android) | S5: bundle+exec a PT binary, or in-process PT crate |
| **PT — webtunnel** | ✅ in-process | ⚠ limited / version-dependent `[VERIFY]` | **major** | as above |
| **PT — snowflake** | ✅ in-process (WebRTC) | ⚠ external / partial `[VERIFY]` | **major** | as above |
| **newCircuit / NEWNYM** | ✅ `SIGNAL NEWNYM` | ⚠ no global NEWNYM; per-stream isolation + `retire_all_circuits()` `[VERIFY semantics]` | **minor** | map `arti_new_identity`; rewire `App.tsx requestNewTorCircuit` (2-line, flag-guarded) |
| **HTTP CONNECT proxy for WebView** (`getHttpTunnelPort` → StiqWebProxy) | ✅ `HTTPTunnelPort auto` | ❌ Arti exposes SOCKS, **no HTTP-CONNECT front** → `arti_http_port() = -1` | **major** | bridge SOCKS→HTTP in-crate, or force reader-mode when -1 |
| **C-tor key/state migration** | n/a (native) | ✅ **not needed** — client regenerates guard/consensus; reach key arrives via join code (see §5) | **none** | — |
| **Background single-daemon / foregroundLock** | serialized `:tor` lifecycle | ⚠ different runtime model; **explicitly out of spike scope** | **major (unresolved)** | design: reconcile `syncTask.ts`/`foregroundLock.ts` with Arti's tokio model |
| **iOS parity** (`StiqTor.swift`) | ✅ (out of scope here) | ❌ not attempted | **major** | separate follow-up ticket |
| **tor version signal** (`torVersion` warn-only guard) | ✅ `GETINFO version` | ⚠ net-new; FFI-only, omitted from event (field optional) | **minor** | expose an `arti_version()` FFI |
| **Binary size (per-ABI .so)** | libtor.so + IPtProxy(Go) + OpenSSL | `[MEASURE]` — see §6 | **unknown → decision input** | run `build.sh`, unzip both APKs |
| **Cold-start / low-end CPU-RAM** | ~30–90 s bootstrap | `[MEASURE]` first-boot regenerates state | **unknown → decision input** | on-device A/B |

**The two hardest gaps are the PT external-binary question and the WebView HTTP-CONNECT gap.**
Both are inherited from Arti's architecture, not from the STIQ integration, and both were flagged as
risks in the plan.

---

## 4. S4 evaluation notes — onion client connect + restricted-discovery client-auth

**Goal (lever 2):** the community relay onion publishes its descriptor encrypted to a shared x25519
auth public key; only a client holding the private key can resolve/rendezvous. STIQ ships the key as
52-char unpadded-uppercase base32 in the join code (community-code v4), validated by
`onionAuth.ts:isValidAuthKeyBase32`.

- **Format translation is the crux.** C-tor consumes a `<host>.auth_private` file line
  (`<host>:descriptor:x25519:<b32>`, produced by `onionAuth.ts:authPrivateFileContent`). **Arti does
  not read that file.** It wants the raw 32-byte x25519 SECRET installed into its `KeyMgr` /
  onion-service-client authorization store, keyed by the `.onion` address. The spike's pure mapper
  `onionAuthArti.ts:artiClientAuthEntry()` reuses the SAME validators (`isValidAuthKeyBase32` +
  `onionHostOf`) and emits the `{onionHost, secretKeyBase32}` shape the FFI expects; `onionAuth.ts`
  is left untouched so the C-tor default path is never at risk. **jest-green.**
- **Rust side (`onion_auth.rs`):** `decode_secret()` base32-decodes 52 chars → 32 bytes;
  `install_into_keymgr()` is `TODO(arti-api)` — the exact `HsClientDescEncKey` / `KeyMgr` type
  path must be pinned against the resolved Arti version and recorded there.
- **Fail-closed is mandatory and wired into `lib.rs`:** an unauthorized client MUST NOT connect
  (that is the entire point of npub-blind reach). `start_async` aborts with `ERR_ONION_AUTH` /
  `error` event if any credential is malformed, and (once implemented) if the descriptor cannot be
  resolved with the installed key.
- **OPEN QUESTION `[VERIFY on device]`:** does Arti support **hot key-add** (install a new
  community/mirror reach key WITHOUT a client restart)? C-tor reads `ClientOnionAuthDir` at startup,
  so community-switch / mirror-add already triggers a daemon restart in STIQ. If Arti's `KeyMgr` also
  needs a restart, behavior is unchanged (no regression); if it can hot-add, that is an
  **improvement** for the multi-community switch path. Record the answer against the pinned version.

**Verdict:** onion connect + restricted-discovery client-auth are the **strongest** part of the Arti
case — architecturally clean, format cleanly translatable, and isolated behind a jest-tested pure
mapper. The only real risk is API churn on the KeyMgr surface (mitigated by pinning + `Cargo.lock`).

---

## 5. S5 evaluation notes — pluggable transports + key/state migration

### 5a. PT support — the primary blocker

- **Incumbent advantage:** IPtProxy 5.5.0 runs obfs4/snowflake/webtunnel **in-process** (lyrebird
  compiled into the gomobile `.aar`). No external exec, no W^X problem — this is exactly why STIQ's
  bridge story "just works" for censored users.
- **Arti reality `[VERIFY]`:** Arti's managed-PT path is `tor-ptmgr`, which for obfs4 typically
  **shells out to an external lyrebird/obfs4 binary**. On modern Android, executing a bundled binary
  from an app-private (writable) directory collides with **W^X / exec-from-writable-storage**
  restrictions. If confirmed, this is a **major/blocker**: bridge support for censored users — the
  users STIQ most exists for — regresses on Arti relative to IPtProxy.
- **Spike scope (S1 step 5):** `arti_start` implements **`direct` only**; `pt.rs:not_supported_in_spike()`
  returns the sentinel `pt-unsupported-in-spike` for every other transport, so an on-device
  `transport=obfs4` attempt fails **precisely** rather than hanging. `pt.rs:parse_bridge_line()` is
  implemented + unit-tested against the real `bridges.ts` `DEFAULT_OBFS4_BRIDGES` format so the
  bridge-config plumbing is ready when a PT path exists.
- **Bridge pools:** `bridges.ts` DEFAULT_OBFS4/SNOWFLAKE bridges still apply as config input;
  DEFAULT_WEBTUNNEL is `[]` (moat-only) regardless of backend.
- **Cascade retune (do NOT do in spike, just record):** if Arti's PT latencies differ, the App.tsx
  transport ladder + `coldTimeoutFor` (snowflake 180 s, etc.) may need retuning — a follow-up, not a
  spike change.

**PT matrix (pinned version, `[VERIFY]`):**

| Transport | Support | Notes |
|---|---|---|
| direct | ✅ (spike target) | proves onion connect without PT |
| obfs4 | ⚠ needs-external-binary `[VERIFY]` | W^X exec-from-app-dir is the blocker |
| webtunnel | ⚠ limited / version-dependent | riskiest after snowflake |
| snowflake | ⚠ external / partial | WebRTC; hardest to embed |

### 5b. Key/state migration (`arti hsc ctor-migrate`) — NOT needed for a client

- `arti hsc ctor-migrate` targets onion **SERVICE** keys. STIQ's client hosts **no** service.
- A Tor **client** carries only **ephemeral** state — guards, consensus cache — which **Arti
  regenerates on first bootstrap**. The durable community **reach key** (x25519 restricted discovery)
  is delivered **fresh** via the join code and installed by S4 — it is never migrated from C-tor's
  `ClientOnionAuthDir`.
- **Conclusion:** **no migration is required.** Arti simply **cold-starts**, accepting a one-time
  slower first bootstrap (guard/consensus rebuild). The real user-visible "migration cost" is that
  first-boot time — which is a `[MEASURE]` item (§6), not a code task. This matches
  `KEY_MIGRATION` in the plan.

---

## 6. Size & low-end perf — the decision inputs that COULD NOT be measured here

> **No toolchain, no device → every number below is an UNMEASURED estimate.** Run
> `client/arti-ffi/build.sh` (emits `SIZE_REPORT.md`) and the on-device A/B before treating any of
> this as fact.

### Binary size (per-ABI `.so`, stripped) `[MEASURE]`

| Component | Incumbent | Arti | Note |
|---|---|---|---|
| Tor core | `libtor.so` (tor-android 0.4.8.22) | `libarti_mobile.so` (arti-client + rustls/ring) | Arti replaces libtor |
| PT | IPtProxy gomobile `.so` (Go runtime — **large**) | folded into arti / or external PT binary | if PT stays external, IPtProxy-equivalent bytes move OUT of the base but reappear as a bundled exec |
| Crypto | OpenSSL `libcrypto/libssl` (shared via `pickFirst` w/ SQLCipher) | rustls/**ring** (statically in arti .so) | op-sqlite still needs OpenSSL regardless |

**Rough, UNVERIFIED expectation:** an arti mobile `.so` with rustls/ring lands in the **single-digit
to low-double-digit MB** per ABI. The **honest** framing: STIQ's incumbent already pays a **large**
Go-runtime cost for IPtProxy, so **dropping PT** could make Arti *comparable or smaller* — but
**keeping** PT (via an external binary) likely makes it *larger AND adds a W^X exec problem*. Because
STIQ is **sideloaded over Tor**, **download bytes are the scarce resource** (`build.gradle`
deliberately keeps legacy compressed packaging for this reason) — so a size regression is a
**first-class NO-GO input**, per the plan's top risk.

**To measure:** `build.sh` writes per-ABI stripped bytes; then
`unzip -l app-arm64-v8a-debug.apk | grep 'lib/arm64-v8a/'` for both the Arti and incumbent builds and
compare total `lib/<abi>` bytes + the resulting APK-download delta.

### Cold-start / low-end CPU-RAM `[MEASURE]`

- **Cold-start-after-fresh-install** is the real "migration cost" (guard/consensus rebuild). Measure
  on a low-end arm64 device and compare to the incumbent's warm reconnect.
- Arti's tokio reactor vs C-tor's thread model has different RAM/CPU characteristics on low-end
  hardware — unmeasured; a potential concern for the exact devices STIQ targets.

---

## 7. Recommendation

### **CONDITIONAL — GO on the seam, NO-GO on a cutover right now.**

The TS seam is **proven and safe to keep dark in-tree**: `ArtiTorBackend` + the flag branch are
jest-green, regression-free, and cannot affect the shipping build (flag defaults false; a
mis-flagged build degrades to **offline, never clearnet**). Keep it.

A **cutover is NOT justified yet** — it is **blocked** on inputs this spike could not produce, plus
two architecture gaps inherited from Arti:

**Top blockers (each tied to a concrete artifact):**
1. **PT external-binary / W^X** (`arti-ffi/src/pt.rs`, §5a) — if obfs4 needs a bundled exec, censored
   users regress vs in-process IPtProxy. **This is the single biggest risk.**
2. **Unmeasured `.so` size + cold-start** (§6, `build.sh` unrun) — for a sideload-over-Tor app,
   download bytes are decisive and remain **unknown**. Cannot GO on faith.
3. **WebView HTTP-CONNECT gap** (`arti_http_port() = -1`, §3) — `StiqWebProxy` loses full-page
   rendering unless a SOCKS→HTTP bridge is built; otherwise reader-mode only.

**Gates that must be TRUE before revisiting GO:**
- [ ] `client/arti-ffi/build.sh` runs on a real toolchain host; `Cargo.lock` committed; every
      `TODO(arti-api)` in `src/*.rs` replaced with pinned type paths.
- [ ] `SIZE_REPORT.md` shows per-ABI `.so` + APK-download delta is **not** a regression (or the
      regression is justified by dropping a larger IPtProxy).
- [ ] On-device: direct onion connect PASS; restricted-discovery connect **PASS with key / FAIL
      without key** (lever-2 preserved); cold-start time acceptable on a low-end device.
- [ ] A credible **in-process** (or safely-exec'd) obfs4 path exists — or STIQ accepts direct-only +
      documents the bridge regression.
- [ ] Decisions recorded for: WebView HTTP-CONNECT, background single-daemon model, iOS parity.

If all gates pass, the phased cutover is low-risk **because the seam already exists**: flip
`USE_ARTI_BACKEND`, ship the `.so` + register `StiqArtiPackage`, A/B against the incumbent (which
stays fully wired), and only then consider removing IPtProxy/tor-android.

---

## 8. Branch disposition & follow-up tickets

- **Keep the flag dark** (`USE_ARTI_BACKEND = false`) and **do NOT merge** to master — this is a
  spike, not a cutover. The TS code is inert; the Rust/Kotlin scaffolds are unregistered and unbuilt.
- **Follow-up tickets (so nothing is lost):**
  1. **T17-F1** Build `arti-ffi` on a toolchain host; commit `Cargo.lock`; fill `SIZE_REPORT.md`;
     resolve all `TODO(arti-api)`.
  2. **T17-F2** On-device S4: restricted-discovery connect-with-key PASS / without-key FAIL against
     the live community onion; determine hot-add vs restart.
  3. **T17-F3** S5 PT decision: in-process obfs4 for Arti, or accept direct-only + document.
  4. **T17-F4** WebView HTTP-CONNECT: SOCKS→HTTP bridge in-crate, or reader-mode-when-`-1`.
  5. **T17-F5** Background single-daemon arbitration (`syncTask.ts` / `foregroundLock.ts`) under
     Arti's tokio runtime.
  6. **T17-F6** iOS `StiqTor.swift` Arti parity.
  7. **T17-F7** App.tsx cascade retune (`requestNewTorCircuit` → Arti; per-transport timeouts) —
     flag-guarded, only if GO.

---

### Appendix — flip-on checklist (spike build only)

1. Build `client/arti-ffi` → `libarti_mobile.so` into `android/app/src/main/jniLibs/<abi>/`.
2. Add `add(StiqArtiPackage())` to `MainApplication.kt getPackages()`.
3. Set `USE_ARTI_BACKEND = true` in `client/src/config.ts`.
4. `npm run verify-deps` → build the arm64 debug APK per `BUILDING.md`.
5. Confirm `NativeModules.StiqArti` is present (JS log) and the UNCHANGED connection UI drives
   `starting → connecting-bridge(%) → connected` purely from `StiqArti`'s `StiqTorStatus` events.
6. A/B: build the SAME commit with `USE_ARTI_BACKEND = false` → behavior byte-identical to master.
