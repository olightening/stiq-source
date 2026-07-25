//! Restricted-discovery (a.k.a. onion client authorization) key handling — T17-S4.
//! ⚠ SCAFFOLD — NOT COMPILED. The base32 decode + validation below is real and unit-tested in
//! spirit (see #[cfg(test)]); the KeyMgr install is a documented TODO(arti-api).
//!
//! STIQ "lever 2": the community relay onion publishes its descriptor ENCRYPTED to a shared
//! x25519 auth PUBLIC key; only a client holding the matching PRIVATE key can resolve/rendezvous.
//! The whole community shares ONE keypair (npub-blind reach) and the private key rides in the join
//! code (community-code v4). See client/src/tor/onionAuth.ts for the pure TS side.
//!
//! CRITICAL FORMAT DIFFERENCE from C-tor: Tor's ClientOnionAuthDir wants a `<host>.auth_private`
//! file whose one line is `<host>:descriptor:x25519:<BASE32>` (onionAuth.ts:authPrivateFileContent).
//! Arti does NOT read that file. It wants the raw 32-byte x25519 SECRET installed into its KeyMgr /
//! onion-service-client authorization store, keyed by the .onion address. So this module decodes the
//! SAME 52-char base32 key STIQ already ships, but installs it via Arti's API instead of writing a
//! file. onionAuth.ts stays untouched (the C-tor path keeps working for the default backend); the
//! Arti-specific validation lives in client/src/tor/onionAuthArti.ts (pure TS mapper) + here.

/// x25519 client-auth key = 32 bytes → 52 chars of unpadded UPPERCASE base32 (RFC4648).
/// Mirrors ONION_AUTH_KEY_LEN / BASE32_KEY_RE in client/src/tor/onionAuth.ts exactly.
pub const ONION_AUTH_KEY_LEN: usize = 52;

/// v3 onion host = 56 base32 chars (lowercase on the wire), WITHOUT the `.onion` suffix.
const V3_ONION_HOST_LEN: usize = 56;

/// Validate an (onionHost, privKeyBase32) pair the way the TS layer does BEFORE we try to install
/// it, so a malformed credential fails fast with a clear message rather than deep inside Arti.
/// Returns Ok(()) when both are well-formed. This is the fail-closed gate referenced by lib.rs.
pub fn validate_entry(onion_host: &str, priv_key_base32: &str) -> Result<(), String> {
    if onion_host.len() != V3_ONION_HOST_LEN
        || !onion_host.bytes().all(|b| is_lower_base32(b))
    {
        return Err(format!("bad onion host (want {V3_ONION_HOST_LEN} base32 chars)"));
    }
    decode_secret(priv_key_base32).map(|_| ())
}

/// Decode the 52-char unpadded-uppercase-base32 x25519 secret into its 32 raw bytes.
/// Rejects wrong length / non-base32 / non-uppercase input (matching isValidAuthKeyBase32).
pub fn decode_secret(priv_key_base32: &str) -> Result<[u8; 32], String> {
    if priv_key_base32.len() != ONION_AUTH_KEY_LEN {
        return Err(format!(
            "bad key length {} (want {ONION_AUTH_KEY_LEN})",
            priv_key_base32.len()
        ));
    }
    if !priv_key_base32.bytes().all(is_upper_base32) {
        return Err("key must be unpadded UPPERCASE base32 ([A-Z2-7])".to_string());
    }
    // TODO(arti-api): use data_encoding::BASE32_NOPAD to decode. 52 base32 chars → 32.5 bytes; the
    // decoder yields 32 bytes (the trailing 4 bits are zero padding for a 256-bit key). Keep the
    // 32-byte prefix. Sketch:
    //   let bytes = data_encoding::BASE32_NOPAD
    //       .decode(priv_key_base32.as_bytes())
    //       .map_err(|e| format!("base32 decode: {e}"))?;
    //   let mut out = [0u8; 32];
    //   out.copy_from_slice(&bytes[..32]);
    //   Ok(out)
    Err("decode_secret: not compiled in the spike host (see TODO)".to_string())
}

/// Install a decoded x25519 secret into Arti's onion-service-client authorization store for `host`.
/// ⚠ TODO(arti-api): the exact types must be verified against the pinned Arti version and recorded
/// in RESTRICTED_DISCOVERY.md. Intended shape (provisional):
///   * build an `HsClientDescEncKey` / `HsClientDescEncSecretKey` from the 32 bytes,
///   * insert it into the TorClient's `KeyMgr` under the key specifier for the parsed `HsId(host)`,
///   * so descriptor decryption uses it automatically on the next connect to that .onion.
/// MUST fail closed: if the key can't be installed OR the descriptor later fails to resolve, the
/// client must NOT connect (unauthorized reach is the exact thing lever-2 prevents).
#[allow(unused_variables)]
pub fn install_into_keymgr(host: &str, secret: [u8; 32]) -> Result<(), String> {
    // TODO(arti-api): real KeyMgr install. See tor-hsclient / arti-client key management docs.
    Err("install_into_keymgr: not compiled in the spike host (see TODO)".to_string())
}

#[inline]
fn is_upper_base32(b: u8) -> bool {
    b.is_ascii_uppercase() && b != b'0' && b != b'1' && b != b'8' && b != b'9'
        || (b'2'..=b'7').contains(&b)
}

#[inline]
fn is_lower_base32(b: u8) -> bool {
    (b'a'..=b'z').contains(&b) || (b'2'..=b'7').contains(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Matches client/src/tor/onionAuthArti.test.ts + onionAuth.test.ts fixtures.
    const HOST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 56 'a'
    const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 52 'A'

    #[test]
    fn rejects_malformed_host_and_key_shapes() {
        assert!(validate_entry("short", KEY).is_err());
        assert!(validate_entry(HOST, "bad").is_err());
        assert!(validate_entry(HOST, &"A".repeat(51)).is_err()); // too short
        assert!(validate_entry(HOST, &"a".repeat(52)).is_err()); // lowercase not allowed
        assert!(validate_entry(HOST, &("A".repeat(50) + "01")).is_err()); // 0/1 not in base32
    }

    #[test]
    fn host_length_and_alphabet() {
        assert_eq!(HOST.len(), V3_ONION_HOST_LEN);
        assert_eq!(KEY.len(), ONION_AUTH_KEY_LEN);
    }

    // NOTE: a real decode round-trip test is gated on the toolchain (data_encoding). It belongs
    // here once the crate compiles:
    //   #[test] fn decodes_known_key() { assert_eq!(decode_secret(KEY).unwrap().len(), 32); }
}
