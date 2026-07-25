package com.stiq.client

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64
import java.io.File
import java.util.concurrent.Executors

/**
 * StiqKeystore — AES-256-GCM encrypted key-value store backed by Android Keystore.
 *
 * The AES master key is generated inside the hardware security module and is non-exportable — it is
 * StrongBox-backed (a dedicated tamper-resistant secure element) when the device has one, falling
 * back to the TEE otherwise (see getOrCreateKey). Each value is encrypted with a fresh 12-byte random
 * IV; the ciphertext+IV is stored as a Base64 string in the app's private files directory.
 *
 * SCOPE OF PROTECTION (security finding #7): the master key is bound to the hardware, NOT to
 * user-authentication or device-unlock. It deliberately does NOT set setUserAuthenticationRequired /
 * setUnlockedDeviceRequired, because the headless background-sync task (src/background/syncTask.ts)
 * must decrypt the SQLCipher cache key and the identity pubkey to sync DMs while the screen is
 * locked — a per-operation biometric prompt or an unlocked-device requirement would break that. The
 * user-facing gate is therefore the app-level PIN/biometric lock + duress wipe (src/lock, src/vault),
 * not a CryptoObject bound to this key. Fully binding key access to user-auth would require splitting
 * this into two keys (a background-usable key for the cache/bridge secrets and an auth-bound key for
 * the identity signing secret) — a larger change tracked as a follow-up.
 *
 * This satisfies the JS SecureStorage interface:
 *   setItem(key, value) / getItem(key) / removeItem(key)
 */
class StiqKeystoreModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqKeystore"

    private val KEYSTORE_ALIAS = "stiq_master_key"
    private val ANDROID_KEYSTORE = "AndroidKeyStore"
    private val AES_GCM = "AES/GCM/NoPadding"
    private val GCM_TAG_BITS = 128
    private val IV_BYTES = 12

    // All crypto + disk I/O runs here, off the shared NativeModules bridge thread. A SINGLE
    // thread (not a pool) preserves JS call order, so a getItem issued after a setItem for the
    // same key always observes the write — the reads-after-writes consistency the JS side relies on.
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "StiqKeystore").apply { isDaemon = true } }

    // The Keystore SecretKey object is stable for the process lifetime; cache it after the first
    // lookup so we don't re-do the getInstance/load/getEntry Binder-IPC round-trips on every call.
    // Only touched on the single io thread, so a plain field is sufficient.
    private var cachedKey: SecretKey? = null

    private fun storageDir(): File =
        File(reactContext.filesDir, "stiq_secure").also { it.mkdirs() }

    private fun getOrCreateKey(): SecretKey {
        cachedKey?.let { return it }
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).also { it.load(null) }
        if (ks.containsAlias(KEYSTORE_ALIAS)) {
            return ((ks.getEntry(KEYSTORE_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey)
                .also { cachedKey = it }
        }
        // Prefer a StrongBox-backed key (dedicated tamper-resistant secure element, API 28+) when the
        // device has one, but fall back to a TEE-backed key if StrongBox is unavailable or rejects the
        // spec — so key creation never bricks on the many devices without StrongBox.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            try {
                return generateMasterKey(useStrongBox = true).also { cachedKey = it }
            } catch (_: Exception) {
                // StrongBoxUnavailableException or a device-specific StrongBox failure: clean up any
                // partial alias so the fallback generateKey() isn't blocked by a duplicate.
                try { ks.deleteEntry(KEYSTORE_ALIAS) } catch (_: Exception) { }
            }
        }
        return generateMasterKey(useStrongBox = false).also { cachedKey = it }
    }

    private fun generateMasterKey(useStrongBox: Boolean): SecretKey {
        val builder = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
        if (useStrongBox && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        kg.init(builder.build())
        return kg.generateKey()
    }

    @ReactMethod
    fun setItem(key: String, value: String, promise: Promise) {
        io.execute {
            try {
                val secretKey = getOrCreateKey()
                val cipher = Cipher.getInstance(AES_GCM)
                cipher.init(Cipher.ENCRYPT_MODE, secretKey)
                val iv = cipher.iv                          // 12 bytes, hardware-random
                val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                // Store as Base64(iv) + ":" + Base64(ciphertext)
                val blob = Base64.encodeToString(iv, Base64.NO_WRAP) +
                    ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
                File(storageDir(), sanitize(key)).writeText(blob, Charsets.UTF_8)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("KEYSTORE_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun getItem(key: String, promise: Promise) {
        io.execute {
            try {
                val file = File(storageDir(), sanitize(key))
                if (!file.exists()) { promise.resolve(null); return@execute }
                val blob = file.readText(Charsets.UTF_8)
                val parts = blob.split(":", limit = 2)
                if (parts.size != 2) { promise.resolve(null); return@execute }
                val iv = Base64.decode(parts[0], Base64.NO_WRAP)
                val ct = Base64.decode(parts[1], Base64.NO_WRAP)
                val secretKey = getOrCreateKey()
                val cipher = Cipher.getInstance(AES_GCM)
                cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, iv))
                val plain = cipher.doFinal(ct).toString(Charsets.UTF_8)
                promise.resolve(plain)
            } catch (e: Exception) {
                promise.reject("KEYSTORE_ERROR", e.message, e)
            }
        }
    }

    // Read + decrypt a single stored item. Mirrors getItem's read+decrypt path exactly (same
    // file layout, same cachedKey via getOrCreateKey, same AES_GCM cipher init), but NEVER throws:
    // a missing / malformed / undecryptable item returns null instead. multiGet relies on this so
    // one bad key can't fail an entire batch — matching getItem's own per-item null-on-absence.
    private fun readItem(key: String): String? {
        return try {
            val file = File(storageDir(), sanitize(key))
            if (!file.exists()) return null
            val blob = file.readText(Charsets.UTF_8)
            val parts = blob.split(":", limit = 2)
            if (parts.size != 2) return null
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ct = Base64.decode(parts[1], Base64.NO_WRAP)
            val secretKey = getOrCreateKey()
            val cipher = Cipher.getInstance(AES_GCM)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.doFinal(ct).toString(Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Batched read: decrypt many keys in ONE task on the single-thread io executor, so app init's
     * ~25-30 secure-storage reads cost a single bridge round-trip + a single serialized run instead
     * of that many. Each key is read via readItem (identical cipher path to getItem, cachedKey
     * reused), and a failed item resolves as null rather than failing the batch. Resolves a map of
     * key -> value-or-null.
     */
    @ReactMethod
    fun multiGet(keys: ReadableArray, promise: Promise) {
        io.execute {
            try {
                val out: WritableMap = Arguments.createMap()
                for (i in 0 until keys.size()) {
                    val key = keys.getString(i) ?: continue
                    val value = readItem(key)
                    if (value == null) out.putNull(key) else out.putString(key, value)
                }
                promise.resolve(out)
            } catch (e: Exception) {
                promise.reject("KEYSTORE_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun removeItem(key: String, promise: Promise) {
        io.execute {
            try {
                File(storageDir(), sanitize(key)).delete()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("KEYSTORE_ERROR", e.message, e)
            }
        }
    }

    // Prevent path traversal: replace anything that isn't alphanumeric / _ - . with _
    private fun sanitize(key: String): String =
        key.replace(Regex("[^a-zA-Z0-9_\\-.]"), "_")
}
