//! Pluggable transports: bridges + the managed PT binary Arti launches.
//!
//! =====================================================================================
//! WHY THIS IS DIFFERENT FROM THE C-TOR PATH
//! =====================================================================================
//! The incumbent backend uses IPtProxy, which compiles lyrebird/snowflake/webtunnel into a gomobile
//! `.aar` and runs them **in-process**. Nothing is ever exec'd, so Android's W^X restrictions never
//! come up.
//!
//! Arti cannot use that. `tor-ptmgr` speaks the Tor *managed pluggable transport* protocol — it
//! spawns an **external process**, hands it `TOR_PT_*` environment variables, and reads `CMETHOD`
//! lines back off its stdout. A JNI library is not something you can spawn.
//!
//! Since API 29, Android also refuses to exec anything from an app-writable directory. The one
//! directory that stays executable is `nativeLibraryDir`, and the packager only puts a file there if
//! it lives in `jniLibs/<abi>/` and is named `lib*.so`. So the PT binaries are real executables that
//! are *named* like shared objects purely to inherit exec permission — the same trick Orbot and Tor
//! Browser Android use. `build-pt.sh` produces `libLyrebird.so`, `libSnowflake.so` and
//! `libWebtunnel.so` that way; libLyrebird answers CMETHOD for BOTH obfs4 and meek_lite (lyrebird
//! registers both internally — see `binary_for`'s doc comment), so there is no separate meek_lite
//! binary. obfs4/libLyrebird has been verified on-device to answer
//! `CMETHOD obfs4 socks5 127.0.0.1:<port>` / `CMETHODS DONE` and to bootstrap a full Arti circuit
//! over a bridge (2.2s, 2026-07-27); snowflake/webtunnel/meek_lite are newer and verified only up to
//! "builds as a PIE executable that links clean" + "Arti's bridge-line parser accepts the exact
//! shape bridges.ts produces for it" (see this file's tests) — not yet exercised against tor-ptmgr
//! on a device.
//!
//! Consequently the Kotlin side must pass `applicationInfo.nativeLibraryDir`, and this module
//! composes the filename. Copying a PT binary anywhere else — notably `filesDir` — produces a file
//! that cannot be executed.

use std::path::{Path, PathBuf};
use std::str::FromStr as _;

use arti_client::config::{
    pt::TransportConfigBuilder, BoolOrAuto, BridgeConfigBuilder, CfgPath, PtTransportName,
    TorClientConfigBuilder,
};

/// Transports STIQ recognizes (must match `TransportType` in client/src/tor/types.ts).
pub const KNOWN_TRANSPORTS: &[&str] = &["direct", "webtunnel", "obfs4", "snowflake", "meek_lite"];

/// The `lib*.so` that provides each transport, or `None` when STIQ does not ship one.
///
/// One binary can provide several protocols: lyrebird registers meek_lite, obfs2/3 and
/// scramblesuit alongside obfs4 (`transports/transports.go`'s `Init()` in the lyrebird source —
/// confirmed by reading it, not assumed from the name), so `libLyrebird.so` is listed twice below
/// with no separate build step for meek_lite. Snowflake and webtunnel are separate upstream programs
/// (`gitlab.torproject.org/.../snowflake/v2/client` and `.../webtunnel/main/client`) with their own
/// binaries. `build-pt.sh` builds every lib*.so named here, so every entry in `KNOWN_TRANSPORTS` maps
/// to a binary. A transport that somehow isn't in this match (there is none today, but a future
/// `KNOWN_TRANSPORTS` entry could outrun this table) fails here with a precise message instead of
/// failing deep inside tor-ptmgr with a spawn error.
fn binary_for(transport: &str) -> Option<&'static str> {
    match transport {
        "obfs4" => Some("libLyrebird.so"),
        "meek_lite" => Some("libLyrebird.so"),
        "snowflake" => Some("libSnowflake.so"),
        "webtunnel" => Some("libWebtunnel.so"),
        _ => None,
    }
}

/// Apply the transport + bridge configuration to a client config under construction.
///
/// `direct` is a no-op — no bridges, no PT process, which is the fast path and must stay free of
/// any PT cost. (The C-tor backend launches an obfs4 process even in direct mode, as a workaround
/// for a TorService init stall; that tax does not carry over here.)
pub fn configure(
    builder: &mut TorClientConfigBuilder,
    transport: &str,
    bridge_lines: &[String],
    native_lib_dir: Option<&str>,
) -> Result<(), String> {
    if transport == "direct" {
        return Ok(());
    }
    if !KNOWN_TRANSPORTS.contains(&transport) {
        return Err(format!("unknown transport '{transport}'"));
    }

    let binary_name = binary_for(transport).ok_or_else(|| {
        format!(
            "transport '{transport}' is in KNOWN_TRANSPORTS but binary_for() has no lib*.so entry \
             for it; add one and build it in client/arti-ffi/build-pt.sh."
        )
    })?;

    // A PT rung with no bridges cannot connect to anything, and the failure would otherwise show up
    // as a bootstrap timeout minutes later.
    if bridge_lines.is_empty() {
        return Err(format!("transport '{transport}' requires at least one bridge line"));
    }

    // Parse the bridges before touching the filesystem: a bad bridge line is something the caller
    // can act on, whereas a missing binary is a packaging fault. Reporting the actionable one first
    // makes the common failure (a stale or mistyped bridge) far easier to diagnose.
    let mut bridges = Vec::with_capacity(bridge_lines.len());
    for line in bridge_lines {
        bridges.push(
            BridgeConfigBuilder::from_str(line)
                .map_err(|e| format!("bad bridge line {line:?}: {e}"))?,
        );
    }

    let dir = native_lib_dir.ok_or(
        "nativeLibDir is required for a pluggable transport (Kotlin passes \
         applicationInfo.nativeLibraryDir; it is the only exec-capable directory on Android)",
    )?;
    let binary = resolve_binary(dir, binary_name)?;

    let protocol = PtTransportName::from_str(transport)
        .map_err(|e| format!("bad transport name '{transport}': {e}"))?;

    let mut pt = TransportConfigBuilder::default();
    pt.protocols(vec![protocol])
        .path(CfgPath::new_literal(binary))
        // Start the process up front rather than on first use. For a PT rung the transport is
        // certainly needed, so launching it during bootstrap overlaps its ~1.5 s startup with
        // directory work instead of adding it to the first channel build.
        .run_on_startup(true);

    let b = builder.bridges();
    // `Auto` would silently fall back to a direct connection if the bridge list ended up empty.
    // On a PT rung the user has already been told direct did not work, so a silent fallback would
    // be both a lie and, in a censored network, a connection attempt they did not consent to.
    b.enabled(BoolOrAuto::Explicit(true));
    b.transports().push(pt);
    for bridge in bridges {
        b.bridges().push(bridge);
    }
    Ok(())
}

/// Resolve and sanity-check the PT executable path.
fn resolve_binary(native_lib_dir: &str, binary_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(native_lib_dir).join(binary_name);
    if !path.exists() {
        return Err(format!(
            "PT binary {} not found. It must be packaged as jniLibs/<abi>/{binary_name} so the \
             installer places it in nativeLibraryDir — run client/arti-ffi/build-pt.sh.",
            path.display()
        ));
    }
    Ok(path)
}

// NOTE: this module used to carry its own `parse_bridge_line`, written when it was unknown whether
// Arti would take torrc-style Bridge lines. It does — `BridgeConfigBuilder` implements `FromStr`
// over exactly the format `bridges.ts` emits — so the hand-rolled parser was deleted rather than
// left to drift out of agreement with the one that actually decides.

#[cfg(test)]
mod tests {
    use super::*;

    const OBFS4_LINE: &str = "obfs4 23.129.64.94:443 21F6BA217C1A9390600D62A6DA6D4D9C9F790259 \
         cert=id1W2fU+DRDy4I+uHZW94QkW7JhEQhW0ZsG5LkFc4804Cj8kuP6oyWZjzH33rlmhSu7JTQ iat-mode=0";

    // Verbatim first entry of DEFAULT_SNOWFLAKE_BRIDGES in bridges.ts (built via `concat!` from the
    // exact same fragments that file joins with `+`, so this can be diffed against it line-for-line).
    // Snowflake's settings shape (fingerprint=/url=/fronts=/ice=/utls-imitate=) is nothing like
    // obfs4's (cert=/iat-mode=) — the whole point of the tests below is that Arti's bridge-line
    // parser does not care, because it treats transport settings as opaque key=value pairs.
    const SNOWFLAKE_LINE: &str = concat!(
        "snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 ",
        "fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 ",
        "url=https://1098762253.rsc.cdn77.org/ ",
        "fronts=www.cdn77.com,www.phpmyadmin.net ",
        "ice=stun:stun.l.google.com:19302,stun:stun.antisip.com:3478,",
        "stun:stun.bluesip.net:3478,stun:stun.dus.net:3478,stun:stun.epygi.com:3478,",
        "stun:stun.sonetel.com:3478,stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,",
        "stun:stun.voys.nl:3478 utls-imitate=hellorandomizedalpn",
    );

    // bridges.ts ships DEFAULT_WEBTUNNEL_BRIDGES EMPTY on purpose (real webtunnel bridges are
    // secret per-deployment and fetched live from the moat API — see that file's module doc), so
    // there is no verbatim line to copy the way there is for obfs4/snowflake. This instead follows
    // the format bridges.ts documents for what it fetches:
    //   webtunnel <ip>:443 <FINGERPRINT> url=https://<domain>/<path> ver=0.0.2
    // The fingerprint reuses one of the (real, but here inert) 40-hex snowflake identities above
    // purely because it is a value already known to be the right shape — webtunnel does not
    // actually use it for anything at this address.
    const WEBTUNNEL_LINE: &str = concat!(
        "webtunnel 192.0.2.9:443 8838024498816A039FCBBAB14E6F40A0843051FA ",
        "url=https://example.invalid/path ver=0.0.2",
    );

    // lyrebird's own transports/meeklite/README.md shows `meek_lite 192.0.2.20:80 url=... front=...`
    // with NO identity word at all — but that example is illustrating the url=/front=/targets=
    // argument syntax in isolation, not a complete bridge line. Arti's `Inner::from_str` requires an
    // RSA identity for EVERY bridge line regardless of transport (`rsa_id.ok_or(BPE::NoRsaIdentity)`
    // in tor-guardmgr's bridge/config.rs), exactly like C tor's own bridge-line parser does — real
    // meek_lite bridge lines (e.g. Tor Browser's historical meek-azure default) always carried a
    // fingerprint. This line adds one (borrowed from SNOWFLAKE_LINE, purely for its correct shape)
    // so the test reflects a real bridge line, not lyrebird's simplified doc snippet.
    const MEEK_LINE: &str = concat!(
        "meek_lite 192.0.2.20:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 ",
        "url=https://example.invalid/ front=cdn.example.invalid",
    );

    #[test]
    fn direct_configures_nothing_and_needs_no_binary() {
        let mut b = TorClientConfigBuilder::default();
        // Passing no lib dir and no bridges must still succeed: this is the fast path.
        assert!(configure(&mut b, "direct", &[], None).is_ok());
    }

    #[test]
    fn an_unknown_transport_is_rejected() {
        let mut b = TorClientConfigBuilder::default();
        let e = configure(&mut b, "garbage", &[], None).unwrap_err();
        assert!(e.contains("unknown transport"), "{e}");
    }

    #[test]
    fn every_known_transport_maps_to_a_binary() {
        // build-pt.sh builds all three PT binaries (lyrebird, snowflake, webtunnel), and lyrebird
        // alone answers for both obfs4 and meek_lite — so all four non-direct KNOWN_TRANSPORTS
        // entries should map to one. `direct` is excluded: `configure` special-cases it before ever
        // consulting binary_for, and it is not itself a pluggable transport.
        for t in KNOWN_TRANSPORTS.iter().copied().filter(|&t| t != "direct") {
            assert!(binary_for(t).is_some(), "{t} should have a bundled PT binary");
        }
    }

    #[test]
    fn an_unrecognized_transport_still_has_no_binary() {
        // Pins binary_for's own behavior independently of configure()'s earlier KNOWN_TRANSPORTS
        // gate (see `an_unknown_transport_is_rejected`), so a future refactor that calls binary_for
        // directly can't silently start handing out a binary path for junk input.
        assert!(binary_for("garbage").is_none());
    }

    #[test]
    fn pt_bridge_lines_configure_reach_the_binary_stage() {
        // Every non-obfs4 transport's bridge-line shape now parses successfully all the way through
        // configure() — the only remaining failure is the deliberately-missing binary at a path that
        // cannot exist. If Arti's BridgeConfigBuilder::from_str ever rejected any of these settings
        // shapes, the error here would say "bad bridge line" instead of naming the binary. (obfs4
        // gets the equivalent coverage from `a_missing_pt_binary_names_the_path_and_the_recipe`.)
        for (t, line, lib) in [
            ("snowflake", SNOWFLAKE_LINE, "libSnowflake.so"),
            ("webtunnel", WEBTUNNEL_LINE, "libWebtunnel.so"),
            ("meek_lite", MEEK_LINE, "libLyrebird.so"),
        ] {
            let mut b = TorClientConfigBuilder::default();
            let e = configure(&mut b, t, &[line.to_string()], Some("/definitely/not/here"))
                .unwrap_err();
            assert!(!e.contains("bad bridge line"), "{t}: {e}");
            assert!(e.contains(lib), "{t}: {e}");
        }
    }

    #[test]
    fn meek_lite_shares_the_lyrebird_binary_with_obfs4() {
        // lyrebird registers meek_lite via the same transports.Init() that registers obfs4 (verified
        // against the upstream source, transports/transports.go) — there is no separate meek_lite
        // build step, so both transport names must resolve to the identical binary.
        assert_eq!(binary_for("meek_lite"), binary_for("obfs4"));
        assert_eq!(binary_for("meek_lite"), Some("libLyrebird.so"));
    }

    #[test]
    fn obfs4_without_bridges_is_rejected_before_bootstrap() {
        let mut b = TorClientConfigBuilder::default();
        let e = configure(&mut b, "obfs4", &[], Some(".")).unwrap_err();
        assert!(e.contains("at least one bridge"), "{e}");
    }

    #[test]
    fn obfs4_without_a_lib_dir_explains_why_one_is_needed() {
        let mut b = TorClientConfigBuilder::default();
        let e = configure(&mut b, "obfs4", &[OBFS4_LINE.to_string()], None).unwrap_err();
        assert!(e.contains("nativeLibDir"), "{e}");
    }

    #[test]
    fn a_missing_pt_binary_names_the_path_and_the_recipe() {
        let mut b = TorClientConfigBuilder::default();
        let e = configure(
            &mut b,
            "obfs4",
            &[OBFS4_LINE.to_string()],
            Some("/definitely/not/here"),
        )
        .unwrap_err();
        assert!(e.contains("libLyrebird.so"), "{e}");
        assert!(e.contains("build-pt.sh"), "{e}");
    }

    #[test]
    fn arti_accepts_the_exact_bridge_format_bridges_ts_ships() {
        // OBFS4_LINE is the first entry of DEFAULT_OBFS4_BRIDGES verbatim. If Arti's parser ever
        // stops accepting that shape, every bridge rung breaks at once and this is the cheapest
        // place to find out.
        assert!(BridgeConfigBuilder::from_str(OBFS4_LINE).is_ok());
    }

    #[test]
    fn arti_accepts_the_exact_snowflake_bridge_format_bridges_ts_ships() {
        // Same rationale as the obfs4 test above, for the other transport bridges.ts hardcodes a
        // default for. Unlike obfs4's RSA fingerprint, snowflake's "fingerprint=" word (and the
        // bare 40-hex word before it, which Arti's parser reads as the bridge's RSA id) are both
        // fixed placeholders — Tor Browser ships the same ones — because snowflake relays are
        // assigned dynamically by the broker, not pinned by identity. Arti's parser does not know
        // or care about that; it just needs 40 hex chars in that slot, which this line has.
        assert!(BridgeConfigBuilder::from_str(SNOWFLAKE_LINE).is_ok());
    }

    #[test]
    fn arti_accepts_the_documented_webtunnel_bridge_format() {
        // See WEBTUNNEL_LINE's comment: bridges.ts never hardcodes a real webtunnel line, so this
        // checks the format its module doc promises moat-fetched lines will have. If that promise
        // and Arti's parser ever disagree, this is the cheapest place to find out — same rationale
        // as the obfs4/snowflake tests above.
        assert!(BridgeConfigBuilder::from_str(WEBTUNNEL_LINE).is_ok());
    }

    #[test]
    fn arti_accepts_a_realistic_meek_lite_bridge_format() {
        // See MEEK_LINE's comment: this is the `url=`/`front=` shape lyrebird's meeklite package
        // documents, with the identity fingerprint a real bridge line needs added back in. Same
        // rationale as the other from_str tests in this file.
        assert!(BridgeConfigBuilder::from_str(MEEK_LINE).is_ok());
    }

    #[test]
    fn a_malformed_bridge_line_names_itself_in_the_error() {
        let mut b = TorClientConfigBuilder::default();
        let e = configure(
            &mut b,
            "obfs4",
            &["obfs4 not-an-address".to_string()],
            Some("."),
        )
        .unwrap_err();
        assert!(e.contains("bad bridge line"), "{e}");
        assert!(e.contains("not-an-address"), "{e}");
    }
}
