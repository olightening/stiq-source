package com.stiq.client

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.MessageDigest

/**
 * StiqPow — NIP-13 proof-of-work miner.
 *
 * The relay gates DM gift wraps (kind 1059) on ~20-bit PoW. Mining that in Hermes JS is far
 * too slow (minutes, and it freezes the UI thread); native SHA-256 (MessageDigest, hardware-
 * accelerated) does it in well under a second.
 *
 * The caller pre-serializes the NIP-01 event with a fixed-width, zero-padded nonce placeholder
 * and passes the placeholder's byte offset. We rewrite only those digit bytes each attempt and
 * hash the buffer until the id has enough leading zero bits, then return the winning nonce as a
 * decimal string (the JS side pads it back to width and finalizes/signs the event).
 */
class StiqPowModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqPow"

    @ReactMethod
    fun minePow(
        serialized: String,
        nonceOffset: Int,
        nonceWidth: Int,
        difficulty: Int,
        promise: Promise,
    ) {
        Thread {
            try {
                val bytes = serialized.toByteArray(Charsets.UTF_8)
                val md = MessageDigest.getInstance("SHA-256")
                var count = 0L
                while (true) {
                    count++
                    var n = count
                    var i = nonceOffset + nonceWidth - 1
                    while (i >= nonceOffset) {
                        bytes[i] = (48 + (n % 10)).toByte()
                        n /= 10
                        i--
                    }
                    md.reset()
                    if (leadingZeroBits(md.digest(bytes)) >= difficulty) break
                }
                promise.resolve(count.toString())
            } catch (e: Exception) {
                promise.reject("POW_ERROR", e)
            }
        }.start()
    }

    private fun leadingZeroBits(hash: ByteArray): Int {
        var count = 0
        for (b in hash) {
            val v = b.toInt() and 0xff
            if (v == 0) {
                count += 8
                continue
            }
            count += Integer.numberOfLeadingZeros(v) - 24
            break
        }
        return count
    }
}
