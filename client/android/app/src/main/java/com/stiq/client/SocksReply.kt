package com.stiq.client

/**
 * Decoding for SOCKS5 reply codes, including Tor's onion-service extended errors.
 *
 * WHY THIS EXISTS: every onion dial failure used to surface as the opaque `rep=1` (SOCKS5 "general
 * failure"). "The descriptor isn't published yet", "the rendezvous timed out" and "your client-auth
 * key is wrong" are the same byte — the first two are transient and worth retrying, the third is
 * fatal and no amount of retrying fixes it. Tuning retry/escalation policy without telling those
 * apart is guesswork.
 *
 * Tor emits the 0xF0-0xF7 codes only when the SOCKSPort carries the `ExtendedErrors` flag (see the
 * torrc built in StiqTorModule). Without it every onion failure collapses back to 0x01. Codes are
 * from tor proposal 304; supported since tor 0.4.3, and the bundled tor is 0.4.8.22.
 *
 * Shared by every SOCKS caller (StiqSocketModule / StiqHttpModule / StiqUpdateModule) so a failure
 * reads the same whichever path hit it. Pure Kotlin, no React surface: the JS Tor API is frozen for
 * Arti-swappability, so this deliberately adds no @ReactMethod and no event.
 */
internal object SocksReply {

    /** True for codes that mean "this onion/keys are wrong" rather than "try again". */
    fun isFatal(code: Int): Boolean = when (code and 0xff) {
        0xF1, 0xF4, 0xF5, 0xF6 -> true // invalid descriptor, missing/wrong client auth, bad address
        else -> false
    }

    fun describe(code: Int): String = when (code and 0xff) {
        // RFC 1928 standard replies.
        0x00 -> "succeeded"
        0x01 -> "general failure"
        0x02 -> "connection not allowed by ruleset"
        0x03 -> "network unreachable"
        0x04 -> "host unreachable"
        0x05 -> "connection refused"
        0x06 -> "TTL expired"
        0x07 -> "command not supported"
        0x08 -> "address type not supported"
        // Tor onion-service extended errors (proposal 304), needs SOCKSPort ExtendedErrors.
        0xF0 -> "onion descriptor not found (service may be offline or not yet published)"
        0xF1 -> "onion descriptor invalid"
        0xF2 -> "onion introduction failed"
        0xF3 -> "onion rendezvous failed"
        0xF4 -> "MISSING client authorization (no .auth key for this onion)"
        0xF5 -> "WRONG client authorization (.auth key rejected by the service)"
        0xF6 -> "invalid onion address"
        0xF7 -> "onion introduction timed out"
        else -> "unknown"
    }

    /**
     * Message for a failed CONNECT. Takes the raw reply byte: Kotlin's Byte.toInt() sign-extends, so
     * an unmasked 0xF0 would read as -16 — mask before doing anything else with it.
     */
    fun failure(raw: Byte): String {
        val code = raw.toInt() and 0xff
        return "SOCKS connect failed rep=0x%02X (%s)".format(code, describe(code))
    }
}
