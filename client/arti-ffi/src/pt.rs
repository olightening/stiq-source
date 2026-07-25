//! Pluggable-transport wiring — T17-S5.   ⚠ SCAFFOLD — NOT COMPILED / NOT WIRED IN THE SPIKE.
//!
//! The spike (S1 step 5) implements ONLY `direct` transport so an onion connect can be proven
//! without blocking on PT. This module is the placeholder for the PT track: it returns a clear
//! not-implemented error for non-direct transports, and carries a bridge-line parser + the findings
//! that feed the PT_GAP matrix in the decision doc.
//!
//! KEY MOBILE-PACKAGING FINDING (to confirm on the toolchain host, drives the go/no-go):
//! The incumbent IPtProxy 5.5.0 runs obfs4/snowflake/webtunnel IN-PROCESS (lyrebird compiled into
//! the gomobile .aar) — no external exec, no W^X problem. Arti's PT story is different: managed PTs
//! go through the `tor-ptmgr` crate which, for obfs4, still shells out to an EXTERNAL lyrebird/obfs4
//! binary. Executing a bundled binary from an app-private dir on modern Android runs into W^X /
//! exec-from-writable-storage restrictions (and Play policy, though STIQ sideloads). That is a
//! MAJOR finding: if obfs4 needs an external exec, bridge support for censored users is at risk on
//! Arti in a way it is NOT on IPtProxy. Snowflake (WebRTC) and webtunnel are riskier still. The
//! decision doc's PT matrix records this as the primary PT blocker until proven otherwise.

/// Transports STIQ recognizes (must match client/src/tor/types.ts TransportType).
pub const KNOWN_TRANSPORTS: &[&str] = &["direct", "webtunnel", "obfs4", "snowflake"];

/// The spike guard lib.rs calls for any non-direct transport. Returns Err with the SAME sentinel
/// message the decision doc / PT matrix cite ("pt-unsupported-in-spike"), so an on-device attempt
/// with transport=obfs4 produces a precisely characterized failure rather than a hang.
pub fn not_supported_in_spike(transport: &str) -> Result<(), String> {
    if transport == "direct" {
        return Ok(());
    }
    if KNOWN_TRANSPORTS.contains(&transport) {
        Err(format!(
            "pt-unsupported-in-spike: transport '{transport}' needs tor-ptmgr + (likely) an external \
             lyrebird/obfs4 binary; not wired in the T17 spike (see PT_GAP in ARTI_MIGRATION_DECISION.md)"
        ))
    } else {
        Err(format!("unknown transport '{transport}'"))
    }
}

/// A parsed bridge line, enough to drive Arti's bridge config once tor-ptmgr is wired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeLine {
    pub transport: String, // obfs4 | snowflake | webtunnel
    pub addr: String,      // ip:port
    pub fingerprint: String,
    /// Remaining `key=value` params (cert=…, iat-mode=…, url=…, fingerprint=…, ice=…, …).
    pub params: Vec<(String, String)>,
}

/// Parse ONE torrc-style Bridge line as they arrive from config.bridgeLines[], matching the format
/// in client/src/tor/bridges.ts DEFAULT_OBFS4_BRIDGES:
///   `obfs4 <ip:port> <FINGERPRINT> cert=… iat-mode=0`
/// Returns None when the line is too short to be a valid bridge. Arti's own config takes these
/// (transport, addr, fingerprint, settings) apart the same way; this is the pre-parse before
/// handing them to tor-ptmgr.
pub fn parse_bridge_line(line: &str) -> Option<BridgeLine> {
    let mut it = line.split_whitespace();
    let transport = it.next()?.to_string();
    let addr = it.next()?.to_string();
    let fingerprint = it.next()?.to_string();
    // A fingerprint is 40 hex chars; guard against a params-only / malformed line.
    if fingerprint.len() != 40 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let params = it
        .filter_map(|tok| tok.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect();
    Some(BridgeLine {
        transport,
        addr,
        fingerprint,
        params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_is_ok_everything_else_is_pt_unsupported() {
        assert!(not_supported_in_spike("direct").is_ok());
        for t in ["obfs4", "webtunnel", "snowflake"] {
            let e = not_supported_in_spike(t).unwrap_err();
            assert!(e.contains("pt-unsupported-in-spike"), "{e}");
        }
        assert!(not_supported_in_spike("garbage").unwrap_err().contains("unknown"));
    }

    #[test]
    fn parses_an_obfs4_bridge_line_matching_bridges_ts() {
        // First line of DEFAULT_OBFS4_BRIDGES in client/src/tor/bridges.ts.
        let line = "obfs4 23.129.64.94:443 21F6BA217C1A9390600D62A6DA6D4D9C9F790259 \
                    cert=id1W2fU+DRDy4I+uHZW94QkW7JhEQhW0ZsG5LkFc4804Cj8kuP6oyWZjzH33rlmhSu7JTQ iat-mode=0";
        let b = parse_bridge_line(line).expect("valid obfs4 line");
        assert_eq!(b.transport, "obfs4");
        assert_eq!(b.addr, "23.129.64.94:443");
        assert_eq!(b.fingerprint, "21F6BA217C1A9390600D62A6DA6D4D9C9F790259");
        assert!(b.params.iter().any(|(k, _)| k == "cert"));
        assert_eq!(
            b.params.iter().find(|(k, _)| k == "iat-mode").map(|(_, v)| v.as_str()),
            Some("0")
        );
    }

    #[test]
    fn rejects_a_line_with_no_fingerprint() {
        assert!(parse_bridge_line("obfs4 1.2.3.4:443").is_none());
        assert!(parse_bridge_line("obfs4 1.2.3.4:443 not-a-fingerprint cert=x").is_none());
    }
}
