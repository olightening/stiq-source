package com.stiq.client

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import fr.acinq.secp256k1.Secp256k1

/**
 * StiqSchnorr — native BIP-340 schnorr signature verification for relay-event ingest.
 *
 * Pure-JS schnorr verify (@noble/curves via nostr-tools) costs several ms per event on Hermes — the
 * per-tick cost floor of the client's paced inbound drain during a relay burst. Same reasoning as
 * StiqPow (native SHA-256 miner) and StiqKdf (native PBKDF2): the curve math belongs in native.
 * Backed by bitcoin-core's libsecp256k1 through the well-vetted secp256k1-kmp JNI bindings (ACINQ),
 * NOT a hand-rolled implementation — correctness over speed.
 *
 * BLOCKING SYNCHRONOUS on purpose: the JS caller (RelayClient's `verify` option, via
 * nostr/nativeVerify.ts) is a synchronous `(event) => boolean` on the ingest hot path; a Promise
 * round-trip per event would defeat the point. A single verify is sub-millisecond, so blocking the
 * JS thread for it is strictly cheaper than the several-ms pure-JS verify it replaces.
 *
 * Returns false — never an exception across the bridge — for ANY malformed input (bad hex, wrong
 * lengths), matching the JS fallback's own catch-all false, so accept/reject parity holds.
 */
class StiqSchnorrModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqSchnorr"

    /**
     * BIP-340 verify: 64-byte schnorr `sigHex` over the 32-byte `msgHashHex` (the Nostr event id)
     * by the 32-byte x-only `pubkeyHex`. All inputs lowercase/uppercase hex.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun verify(pubkeyHex: String, msgHashHex: String, sigHex: String): Boolean =
        try {
            val sig = hexToBytes(sigHex)
            val msg = hexToBytes(msgHashHex)
            val pub = hexToBytes(pubkeyHex)
            sig.size == 64 && msg.size == 32 && pub.size == 32 &&
                Secp256k1.verifySchnorr(sig, msg, pub)
        } catch (e: Exception) {
            false
        }

    private fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "odd-length hex" }
        val out = ByteArray(hex.length / 2)
        var i = 0
        while (i < out.size) {
            out[i] = ((hexDigit(hex[i * 2]) shl 4) or hexDigit(hex[i * 2 + 1])).toByte()
            i++
        }
        return out
    }

    private fun hexDigit(c: Char): Int =
        when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + 10
            in 'A'..'F' -> c - 'A' + 10
            else -> throw IllegalArgumentException("bad hex")
        }
}
