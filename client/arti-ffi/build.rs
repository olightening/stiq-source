//! Attach the linker version script to the Android cdylib.
//!
//! See `arti-mobile.map` for why hiding symbols is a correctness requirement here and not just a
//! size optimisation: this library statically links its own sqlite, and the app already loads
//! SQLCipher, which exports the same names.
//!
//! `rustc-cdylib-link-arg` applies to the cdylib only, so the unit-test binary — which has to keep
//! its own symbols visible to run at all — is unaffected.

fn main() {
    println!("cargo:rerun-if-changed=arti-mobile.map");
    println!("cargo:rerun-if-changed=build.rs");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") {
        return;
    }

    let dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    // Forward slashes even on Windows: the path is passed through `-Wl,` and a backslash there is
    // an escape character to the linker's argument parser, not a separator.
    let map = format!("{dir}/arti-mobile.map").replace('\\', "/");
    println!("cargo:rustc-cdylib-link-arg=-Wl,--version-script={map}");

    // 16 KB page alignment. NOT an optimisation — a load-bearing compatibility requirement.
    //
    // Devices shipping a 16 KB-page kernel (Pixel 9 class and later) cannot mmap an ELF whose LOAD
    // segments are aligned to the historical 4 KB. The library simply fails to load, at process
    // start, with a linker message that says nothing about alignment — so the app appears to be
    // broken on new hardware for no visible reason, and only on hardware the developer probably
    // does not own. `llvm-readelf -l` reported 0x1000 here before this flag; it must read 0x4000.
    //
    // ⚠ `rustc-link-arg`, NOT `rustc-cdylib-link-arg` — this must reach the TEST BINARY TOO.
    //
    // FOUND THE HARD WAY, 2026-07-27. This line used to be `rustc-cdylib-link-arg`, which does
    // exactly what its name says: the shipped .so got 0x4000 and the unit-test executable kept the
    // historical 0x1000. build.sh's documented workflow is to run those tests ON A DEVICE (there is
    // no host C compiler here, so `cargo test` cannot run locally) — and on a 16 KB-page device the
    // test binary dies at exec with a bare
    //
    //     Segmentation fault
    //
    // before `main`, before even `--list` prints one line. No linker message, no test names,
    // nothing pointing at alignment. Verified with `llvm-readelf -l`: the test binary read
    // `0x1000 0x1000 0x1000 0x1000` while the cdylib built beside it from the same source read
    // `0x4000`.
    //
    // That is not a niche case, it is the DEFAULT case going forward: Pixel-9-class hardware and
    // the `..._ps16k` emulator images (`adb shell getconf PAGE_SIZE` → 16384) both run 16 KB
    // kernels. Left as cdylib-only, this crate's entire test suite is unrunnable on any current
    // test target, while looking like a crash in the code under test.
    //
    // (`rustc-link-arg-tests` is NOT the fix: these are unit tests inside the lib target, and cargo
    // rejects that instruction outright here — "The package arti-mobile does not have a test
    // target." The unqualified form covers cdylibs and test harnesses alike.)
    println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
}
