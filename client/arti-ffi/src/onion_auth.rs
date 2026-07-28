//! Restricted-discovery (a.k.a. onion client authorization) key handling — T17-S4.
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

use std::str::FromStr as _;

use arti_client::{HsClientDescEncKey, HsId, KeystoreSelector, TorClient};
use tor_hscrypto::pk::HsClientDescEncSecretKey;
use tor_llcrypto::pk::curve25519;
use tor_rtcompat::Runtime;

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
    // 52 base32 chars carry 260 bits, and a x25519 secret is 256 — the last character contributes
    // 4 bits of zero padding. `BASE32_NOPAD` checks those trailing bits are actually zero, which is
    // a free extra sanity check on the credential: a truncated or re-encoded key fails here rather
    // than silently becoming a different key.
    let bytes = data_encoding::BASE32_NOPAD
        .decode(priv_key_base32.as_bytes())
        .map_err(|e| format!("base32 decode: {e}"))?;
    let out: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("decoded {} bytes, want 32", bytes.len()))?;
    Ok(out)
}

/// Install a decoded x25519 secret into Arti's keystore so it can decrypt `onion_host`'s descriptor.
///
/// This is STIQ's "lever 2" under Arti: the community relay publishes its descriptor encrypted to a
/// shared auth public key, and only a client holding the private half can resolve it. Everyone in a
/// community shares one keypair, which is what keeps reach npub-blind.
///
/// Two things here are easy to get wrong:
///
///   * **`HsId` will not parse a bare host.** Its `FromStr` calls `strip_suffix_ignore_ascii_case(".onion")`
///     and returns `NotOnionDomain` when the suffix is absent. STIQ stores hosts *without* the
///     suffix (see `onionAuth.ts`), so it has to be appended here.
///   * **This is not the C-tor format.** Tor reads a `<host>.auth_private` file whose single line is
///     `<host>:descriptor:x25519:<BASE32>`. Arti reads nothing of the sort; the key goes into its
///     keystore through this API. `onionAuth.ts` stays as it is — it still feeds the C-tor backend —
///     and only the transport of the same 52-char secret changes.
///
/// Callers must treat a failure as fatal. A client that starts without its key bootstraps perfectly
/// well and then cannot resolve the descriptor at all, which surfaces much later as an opaque
/// connect failure.
/// It must also be IDEMPOTENT, and that is not free.
///
/// `insert_service_discovery_key` hardcodes `overwrite = false` and exposes no way to change it, so
/// inserting a key that is already stored fails with `KeyAlreadyExists` → `ErrorKind::BadApiUsage`
/// → "bad API usage (bug): Error while trying to access a key store". Since the keystore lives in
/// app-private storage and survives restarts, while `startTor` runs on every connect and on every
/// rung of the connect ladder, the *first* install succeeds and every subsequent one fails — which
/// is a permanently broken app after one successful run, from a message that reads like a bug in
/// the caller.
///
/// So: install only what is missing, and replace what has changed. The second case is the one that
/// matters operationally — a community that rotates its auth key would otherwise keep being reached
/// with the stale one, and the only symptom would be a descriptor that will not decrypt.
pub fn install_into_keymgr<R: Runtime>(
    client: &TorClient<R>,
    onion_host: &str,
    secret: [u8; 32],
) -> Result<(), String> {
    // `HsId::from_str` requires the suffix; STIQ stores hosts without it.
    let hsid = HsId::from_str(&format!("{onion_host}.onion"))
        .map_err(|e| format!("bad onion host '{onion_host}': {e}"))?;
    let sk = HsClientDescEncSecretKey::from(curve25519::StaticSecret::from(secret));
    let wanted = HsClientDescEncKey::from(&sk);

    // Every `{e}` below is an `arti_client::Error` routed through `describe_arti_error` rather
    // than interpolated raw. These are local keystore operations, not live circuit-building, so
    // there is no HsDir/rendezvous relay to name here today — but the error type is the SAME
    // opaque, kitchen-sink `arti_client::Error` used on the live-connect paths, and nothing
    // guarantees a future arti version keeps it that way. See `describe_arti_error`'s doc in
    // lib.rs for why this crate does not interpolate that type raw anywhere.
    let stored = client
        .get_service_discovery_key(hsid)
        .map_err(|e| format!("keystore read failed: {}", crate::describe_arti_error(&e)))?;

    match stored {
        // Already installed and identical — nothing to do. This is the common path on every
        // connect after the first.
        Some(existing) if existing == wanted => return Ok(()),
        // A different key is stored for this onion: the community rotated it. Remove before
        // inserting, because insert alone cannot overwrite.
        Some(_) => {
            client
                .remove_service_discovery_key(KeystoreSelector::Primary, hsid)
                .map_err(|e| format!("keystore replace failed: {}", crate::describe_arti_error(&e)))?;
        }
        None => {}
    }

    client
        .insert_service_discovery_key(KeystoreSelector::Primary, hsid, sk)
        .map_err(|e| format!("keystore insert failed: {}", crate::describe_arti_error(&e)))?;
    Ok(())
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

    #[test]
    fn decodes_a_52_char_key_to_exactly_32_bytes() {
        let all_a = decode_secret(KEY).expect("52 'A's is a valid all-zero key");
        assert_eq!(all_a, [0u8; 32]);
    }

    #[test]
    fn decodes_a_key_with_real_entropy() {
        // BASE32_NOPAD of 32 bytes 0x00,0x01,…,0x1F. Round-trips through the same encoder the TS
        // side uses, so this pins the alphabet and bit order, not just the length.
        let mut raw = [0u8; 32];
        for (i, b) in raw.iter_mut().enumerate() {
            *b = i as u8;
        }
        let encoded = data_encoding::BASE32_NOPAD.encode(&raw);
        assert_eq!(encoded.len(), ONION_AUTH_KEY_LEN);
        assert_eq!(decode_secret(&encoded).unwrap(), raw);
    }

    #[test]
    fn rejects_a_key_whose_padding_bits_are_not_zero() {
        // 260 bits of base32 hold a 256-bit key plus 4 bits that must be zero. A key that sets them
        // is not a re-encoding of any 32-byte secret — it is a corrupted or truncated credential,
        // and silently accepting it would install a DIFFERENT key than the community issued.
        let bad = "A".repeat(51) + "B"; // 'B' = 00001, so the low padding bits are set
        assert!(decode_secret(&bad).is_err());
    }
}
