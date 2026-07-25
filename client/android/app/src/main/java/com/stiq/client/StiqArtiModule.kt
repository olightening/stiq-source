package com.stiq.client

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * StiqArtiModule — T17 Arti-migration SPIKE native module.   ⚠ SCAFFOLD — NOT BUILT / NOT WIRED.
 *
 * =====================================================================================
 * BUILD STATUS: this module has NOT been compiled. The spike host has no Android SDK/NDK build set
 * up, so `./gradlew assembleDebug` was not run. It also is deliberately NOT registered in
 * MainApplication.kt (see StiqArtiPackage.kt) — the branch stays inert and isolated. To activate on
 * the spike build: (1) build client/arti-ffi → libarti_mobile.so into jniLibs, (2) add
 * `add(StiqArtiPackage())` to MainApplication.getPackages(), (3) flip USE_ARTI_BACKEND=true.
 * =====================================================================================
 *
 * It mirrors StiqTorModule.kt method-for-method so the TS layer (ArtiTorBackend, jest-green) needs
 * ZERO wire changes:
 *   getName()="StiqArti", startTor/stopTor/newCircuit/getHttpTunnelPort/addListener/removeListeners,
 *   and it pushes status via RCTDeviceEventEmitter.emit("StiqTorStatus", WritableNativeMap) with the
 *   IDENTICAL shapes StiqTorModule builds (emitStarting/emitBootstrapping/emitConnected/emitError/
 *   emitStopped below are copied verbatim from StiqTorModule.kt:1085+).
 *
 * The difference: instead of tor-android's TorService + IPtProxy Controller + the control-socket
 * monitor + the teardown barrier, it marshals the ReadableMap into the S1 JSON and calls the
 * arti-ffi cdylib (arti_start/arti_stop/arti_new_identity/arti_http_port). Arti has no in-process
 * `tor_run_main()` reentry hazard, so the whole :tor-process-isolation + forced-kill machinery in
 * StiqTorModule is GONE here — a big simplification if the spike graduates.
 */
class StiqArtiModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqArti"

    // Single background executor for the (potentially blocking) arti_start/stop calls — never on the
    // JS thread. Mirrors StiqTorModule's lifecycleExecutor intent (serialize native lifecycle work).
    private val lifecycleExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "StiqArti-lifecycle")
    }

    @Volatile private var lastHttpPort = -1

    // ── FFI ──────────────────────────────────────────────────────────────────────────────────────
    // TODO(arti-ffi): if using uniffi, delete these external declarations and call the generated
    // Kotlin bindings instead. Under the plain-extern path, these map to the #[no_mangle] extern "C"
    // exports in client/arti-ffi/src/lib.rs, and the ArtiBootstrap callback is registered via a JNI
    // shim that routes on_event(kind, …) → dispatchEvent(kind, …) below.
    //
    //   private external fun artiStart(configJson: String): Int
    //   private external fun artiStop()
    //   private external fun artiNewIdentity()
    //   private external fun artiHttpPort(): Int
    //   private external fun artiInitLogging()
    //
    // companion object { init { System.loadLibrary("arti_mobile") } }

    /**
     * Called BY the Rust ArtiBootstrap callback (via JNI/uniffi) for every status event. `kind` is a
     * TorBackendEvent kind. Routes to the matching emit* helper, building the SAME WritableNativeMap
     * shapes StiqTorModule emits — so 'StiqTorStatus' deserializes into TorBackendEvent unchanged.
     * `startPromise` is resolved on 'connected' and rejected on 'error'.
     */
    @Suppress("unused") // invoked from native
    fun dispatchEvent(kind: String, percent: Int, summary: String, socksPort: Int, message: String) {
        when (kind) {
            "starting" -> emitStarting()
            "bootstrapping" -> emitBootstrapping(percent, summary.ifEmpty { "Connecting" })
            "connected" -> {
                emitConnected(socksPort)
                startPromise?.resolve(null)
                startPromise = null
            }
            "error" -> {
                emitError(message.ifEmpty { "Arti error" })
                startPromise?.reject("arti_error", message.ifEmpty { "Arti error" })
                startPromise = null
            }
            "stopped" -> emitStopped()
        }
    }

    private var startPromise: Promise? = null

    // ── React methods (mirror StiqTorModule surface) ──────────────────────────────────────────────

    @ReactMethod
    fun startTor(config: ReadableMap, promise: Promise) {
        startPromise = promise
        emitStarting()
        // Resolve the app-private Arti state dir here (Kotlin owns filesystem paths), then hand a
        // single JSON string to Rust. Mirrors StiqTorModule resolving getDir("TorService", …).
        val dataDir = reactContext.getDir("ArtiState", ReactApplicationContext.MODE_PRIVATE).absolutePath
        val json = buildConfigJson(config, dataDir)
        lifecycleExecutor.execute {
            try {
                // val rc = artiStart(json)   // >0 SOCKS port on success; <0 codes::* on failure
                // if (rc < 0) { /* dispatchEvent already emitted 'error'; ensure promise settled */ }
                // lastHttpPort = artiHttpPort()
                android.util.Log.i("StiqArti", "startTor scaffold — would call arti_start($json)")
                // Scaffold has no native lib: fail closed so a mis-flagged build goes OFFLINE, never
                // clearnet (matches ArtiTorBackend/UnavailableTorBackend safe-degrade on the TS side).
                emitError("StiqArti native lib not built (spike scaffold)")
                startPromise?.reject("arti_not_built", "StiqArti native lib not built (spike scaffold)")
                startPromise = null
            } catch (e: Throwable) {
                android.util.Log.e("StiqArti", "startTor failed", e)
                emitError(e.message ?: "arti_start failed")
                startPromise?.reject("arti_start_failed", e.message ?: "arti_start failed")
                startPromise = null
            }
        }
    }

    @ReactMethod
    fun stopTor(promise: Promise) {
        lifecycleExecutor.execute {
            try {
                // artiStop()  // drops the TorClient + SOCKS task; Rust fires 'stopped'
                android.util.Log.i("StiqArti", "stopTor scaffold — would call arti_stop()")
                emitStopped()
            } catch (_: Throwable) {
                emitStopped()
            }
            promise.resolve(null)
        }
    }

    /** Rotate identity. Arti has no global NEWNYM; arti_new_identity retires circuits (see lib.rs).
     *  If it proves a no-op vs C-tor NEWNYM, that is a documented spike gap (decision doc §newCircuit). */
    @ReactMethod
    fun newCircuit(promise: Promise) {
        lifecycleExecutor.execute {
            try {
                // artiNewIdentity()
                android.util.Log.i("StiqArti", "newCircuit scaffold — would call arti_new_identity()")
            } catch (_: Throwable) {}
            promise.resolve(null)
        }
    }

    /** HTTP CONNECT proxy port for the opt-in full-page WebView, or -1 when Arti exposes none
     *  (WebView-proxy GAP — StiqWebProxy must fall back to reader-mode; see decision doc). */
    @ReactMethod
    fun getHttpTunnelPort(promise: Promise) {
        promise.resolve(lastHttpPort)
    }

    @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}
    @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}

    // ── Config marshaling (ReadableMap → the S1 JSON string) ──────────────────────────────────────

    /**
     * Build the single JSON string arti_start consumes, mirroring TorStartConfig
     * (client/src/tor/types.ts) and ffi.rs::TorStartConfigJson. Passes the raw privKeyBase32 through
     * for BOTH onionAuth and every onionAuthExtra entry — the Rust side (onion_auth.rs) validates +
     * decodes, and the Kotlin module does NOT write any C-tor `<host>.auth_private` file (that format
     * is dead for Arti).
     */
    private fun buildConfigJson(config: ReadableMap, dataDir: String): String {
        val root = JSONObject()
        root.put("transport", config.getString("transport") ?: "direct")
        root.put("bridgeLines", readStringArray(config.getArray("bridgeLines")))
        root.put("socksPort", if (config.hasKey("socksPort")) config.getInt("socksPort") else 0)
        root.put("dataDir", dataDir)
        config.getMap("onionAuth")?.let { root.put("onionAuth", authToJson(it)) }
        config.getArray("onionAuthExtra")?.let { extra ->
            val arr = JSONArray()
            for (i in 0 until extra.size()) {
                extra.getMap(i)?.let { arr.put(authToJson(it)) }
            }
            root.put("onionAuthExtra", arr)
        }
        root.put("dormancy", config.hasKey("dormancy") && config.getBoolean("dormancy"))
        return root.toString()
    }

    private fun authToJson(m: ReadableMap): JSONObject =
        JSONObject()
            .put("onionHost", m.getString("onionHost") ?: "")
            .put("privKeyBase32", m.getString("privKeyBase32") ?: "")

    private fun readStringArray(arr: ReadableArray?): JSONArray {
        val out = JSONArray()
        if (arr != null) for (i in 0 until arr.size()) out.put(arr.getString(i))
        return out
    }

    // ── Event emitters (COPIED VERBATIM from StiqTorModule.kt so the wire shapes match exactly) ────

    private fun emit(body: WritableNativeMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("StiqTorStatus", body)
    }

    private fun emitStarting() =
        emit(WritableNativeMap().apply { putString("kind", "starting") })

    private fun emitBootstrapping(percent: Int, summary: String) =
        emit(WritableNativeMap().apply {
            putString("kind", "bootstrapping")
            putInt("percent", percent)
            putString("summary", summary)
        })

    private fun emitConnected(socksPort: Int) =
        emit(WritableNativeMap().apply {
            putString("kind", "connected")
            putMap("socks", WritableNativeMap().apply {
                putString("host", "127.0.0.1")
                putInt("port", socksPort)
            })
            // NOTE: no torVersion here — Arti's version signal is net-new (FFI-only, decision doc),
            // and the field is optional in TorBackendEvent, so omitting it stays wire-valid.
        })

    private fun emitError(message: String) =
        emit(WritableNativeMap().apply {
            putString("kind", "error")
            putString("message", message)
        })

    private fun emitStopped() =
        emit(WritableNativeMap().apply { putString("kind", "stopped") })
}
