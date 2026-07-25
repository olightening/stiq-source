package com.stiq.client

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.math.BigInteger

/**
 * StiqRsaMath — native 2048-bit modular arithmetic for the blind-RSA token pathway.
 *
 * A wallet refill blinds/unblinds a whole batch (DRAW_BATCH=100 posting tokens) and every one of
 * those tokens costs modular exponentiations and an inverse over the issuer's RSA-2048 modulus.
 * In Hermes those run as pure-JS bignum math (sjcl inside @cloudflare/blindrsa-ts + BigInt in the
 * WebCrypto shim) — tolerable on a flagship, seconds of JS-thread work on a mid-range SoC, felt as
 * action lag while a refill is in flight. Android's BigInteger delegates to BoringSSL BIGNUM, so
 * the same ops complete in well under a millisecond here — same precedent as StiqKdf's PBKDF2 and
 * StiqPow's SHA-256 miner ("far too slow in Hermes JS").
 *
 * The methods are per-token composites (one bridge round-trip per token per phase) rather than a
 * generic modPow, so a 100-token draw costs 100 calls, not 300+. All inputs/outputs are lowercase
 * hex magnitudes (BigInteger(hex, 16) / toString(16)); leading zeros are irrelevant on both sides.
 * Only PUBLIC key material and per-token blinding values cross this bridge — the issuer's private
 * key never exists on the client at all.
 */
class StiqRsaMathModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqRsaMath"

    /**
     * Blind-side ops for one token (RFC 9474 blind()):
     *   inv = r^-1 mod n   (rejects with ArithmeticException when gcd(r, n) != 1 — the JS caller
     *                       resamples r; with a real RSA modulus this is astronomically rare)
     *   z   = m * r^e mod n (the blinded message shown to the issuer)
     */
    @ReactMethod
    fun blindOps(rHex: String, eHex: String, mHex: String, nHex: String, promise: Promise) {
        Thread {
            try {
                val r = BigInteger(rHex, 16)
                val e = BigInteger(eHex, 16)
                val m = BigInteger(mHex, 16)
                val n = BigInteger(nHex, 16)
                val inv = r.modInverse(n)
                val z = m.multiply(r.modPow(e, n)).mod(n)
                val out = Arguments.createMap()
                out.putString("inv", inv.toString(16))
                out.putString("z", z.toString(16))
                promise.resolve(out)
            } catch (t: Throwable) {
                promise.reject("RSA_MATH_ERROR", t)
            }
        }.start()
    }

    /**
     * Finalize-side ops for one token (RFC 9474 finalize()):
     *   s  = zSig * inv mod n  (unblind the issuer's blind signature)
     *   em = s^e mod n         (RSAVP1 — the PSS representative; the JS side runs EMSA-PSS-VERIFY
     *                           over it before the signature is trusted as a token)
     */
    @ReactMethod
    fun finalizeOps(zSigHex: String, invHex: String, eHex: String, nHex: String, promise: Promise) {
        Thread {
            try {
                val zSig = BigInteger(zSigHex, 16)
                val inv = BigInteger(invHex, 16)
                val e = BigInteger(eHex, 16)
                val n = BigInteger(nHex, 16)
                val s = zSig.multiply(inv).mod(n)
                val em = s.modPow(e, n)
                val out = Arguments.createMap()
                out.putString("s", s.toString(16))
                out.putString("em", em.toString(16))
                promise.resolve(out)
            } catch (t: Throwable) {
                promise.reject("RSA_MATH_ERROR", t)
            }
        }.start()
    }
}
