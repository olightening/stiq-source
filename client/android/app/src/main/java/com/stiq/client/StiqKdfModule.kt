package com.stiq.client

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * StiqKdf — native PBKDF2-HMAC-SHA256 for the app-lock PIN.
 *
 * Deriving the PIN KDF in Hermes JS is unusably slow: pure-JS scrypt(N=16384) measures ~11s on a
 * modern device (Galaxy S23 Ultra), and the cost is LINEAR in N, so no JS-cheap parameter both keeps
 * a real memory/iteration-hard KDF AND unlocks instantly — every unlock froze behind an 11-second
 * derive. Native PBKDF2 via SecretKeyFactory (Conscrypt/BoringSSL, hardware-accelerated SHA-256) runs
 * a high iteration count in tens of milliseconds. Same reasoning as StiqPow's native SHA-256 miner:
 * "far too slow in Hermes JS … native (hardware-accelerated) does it in well under a second."
 *
 * The PIN is always ASCII digits (numeric keypad), so PBEKeySpec's char→byte encoding is unambiguous
 * (identical to the JS side's UTF-8 bytes), which keeps the pure-JS pbkdf2 fallback in nativeKdf.ts
 * byte-compatible. Nothing here logs or persists the PIN; the char[] is scrubbed after use.
 */
class StiqKdfModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqKdf"

    @ReactMethod
    fun pbkdf2(pin: String, saltHex: String, iterations: Int, dkLenBytes: Int, promise: Promise) {
        Thread {
            var spec: PBEKeySpec? = null
            try {
                val salt = hexToBytes(saltHex)
                spec = PBEKeySpec(pin.toCharArray(), salt, iterations, dkLenBytes * 8)
                val skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                val dk = skf.generateSecret(spec).encoded
                promise.resolve(bytesToHex(dk))
            } catch (e: Exception) {
                promise.reject("KDF_ERROR", e)
            } finally {
                spec?.clearPassword()
            }
        }.start()
    }

    private fun hexToBytes(hex: String): ByteArray {
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

    private fun bytesToHex(bytes: ByteArray): String {
        val hex = "0123456789abcdef"
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(hex[v ushr 4])
            sb.append(hex[v and 0x0f])
        }
        return sb.toString()
    }
}
