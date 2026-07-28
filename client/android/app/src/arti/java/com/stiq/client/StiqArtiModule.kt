package com.stiq.client

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
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
 * StiqArtiModule — the RN bridge to the Arti (pure-Rust Tor) backend.
 *
 * It mirrors StiqTorModule.kt method-for-method so the TS layer (ArtiTorBackend) needs ZERO wire
 * changes: getName()="StiqArti", startTor/stopTor/newCircuit/setDormant/setActive/
 * getHttpTunnelPort/getNetworkClass/addListener/removeListeners, and it pushes status via
 * RCTDeviceEventEmitter.emit("StiqTorStatus", WritableNativeMap) with the IDENTICAL shapes
 * StiqTorModule builds.
 *
 * The difference: instead of tor-android's TorService + IPtProxy Controller + the control-socket
 * monitor + the teardown barrier, it marshals the ReadableMap into one JSON string and calls into
 * `libarti_mobile.so`. Arti has no in-process `tor_run_main()` reentry hazard, so the whole
 * :tor-process-isolation + forced-kill machinery in StiqTorModule is simply absent here.
 *
 * ── THE NATIVE LIBRARY LOADS LAZILY, AND THAT IS DELIBERATE ───────────────────────────────────────
 * `System.loadLibrary("arti_mobile")` runs on the first startTor(), not in a static initializer.
 * The library is tens of megabytes; loading it eagerly (e.g. from MainApplication's package list
 * registration, which runs on every cold start whether or not the user ever connects) would be a
 * real regression for the exact metric this work exists to improve. Deferring the load to the
 * first actual startTor() call keeps registration itself free.
 *
 * ── IT STILL FAILS CLOSED ────────────────────────────────────────────────────────────────────────
 * If the .so is missing from the APK, `ensureNativeLoaded()` returns false and startTor rejects.
 * That degrades to OFFLINE, never to clearnet — matching UnavailableTorBackend on the TS side.
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

    // Default-network monitor, mirroring StiqTorModule's. Without it the JS layer never learns about
    // a Wi-Fi↔cellular switch, so a circuit that died with the old network lingers until the ~90 s
    // watchdog notices. Best-effort: absent on any failure, so it can only help recovery.
    @Volatile private var connectivityCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile private var lastNetwork: Network? = null

    // ── FFI ──────────────────────────────────────────────────────────────────────────────────────
    // These bind by SYMBOL NAME to the #[no_mangle] exports in client/arti-ffi/src/jni_bridge.rs
    // (`Java_com_stiq_client_StiqArtiModule_<name>`). Nothing checks that correspondence at build
    // time: rename this class, move the package, or rename a method here, and the build stays green
    // and throws UnsatisfiedLinkError on first call instead. Change both sides together.
    private external fun artiRegisterCallback()
    private external fun artiStart(configJson: String): Int
    private external fun artiInstallAuth(reachJson: String): Int
    private external fun artiStop()
    private external fun artiNewIdentity()
    private external fun artiSetDormant(dormant: Boolean)
    private external fun artiHttpPort(): Int

    @Volatile private var nativeLoaded = false

    /**
     * Load `libarti_mobile.so` and register this instance as the event sink, once.
     *
     * Called only from the single-threaded lifecycleExecutor, so no extra locking is needed — but it
     * is written to be idempotent anyway, because getting this wrong would register two callbacks
     * and double every bootstrap event.
     */
    private fun ensureNativeLoaded(): Boolean {
        if (nativeLoaded) return true
        return try {
            System.loadLibrary("arti_mobile")
            // Register BEFORE any start, so that errors raised by a failed start still have
            // somewhere to go. This also initialises the logcat bridge on the Rust side.
            artiRegisterCallback()
            nativeLoaded = true
            true
        } catch (e: Throwable) {
            android.util.Log.e("StiqArti", "libarti_mobile.so not loadable", e)
            false
        }
    }

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
            // Deferred reachability verdict — always AFTER 'connected', so startPromise is already
            // settled and neither kind may touch it. Pure pass-throughs to the TS layer, which owns
            // the ladder reaction (record-warm vs condemn-and-walk-on).
            "verified" -> emitKindOnly("verified")
            "transport-dead" -> emitTransportDead(message.ifEmpty { "transport dead" })
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
        // Kotlin owns filesystem paths. This computed value is the app-private Arti state root
        // (mirroring StiqTorModule resolving getDir("TorService", …)) and is the DEFAULT — but
        // buildConfigJson honors a caller-supplied config.dataDir over it (see the note there).
        // `nativeLibDir` is where a pluggable transport binary can actually be executed from, and is
        // Kotlin-only — the JS TorStartConfig never carries it.
        val dataDir = reactContext.getDir("ArtiState", ReactApplicationContext.MODE_PRIVATE).absolutePath
        val nativeLibDir = reactContext.applicationInfo.nativeLibraryDir
        val json = buildConfigJson(config, dataDir, nativeLibDir)
        lifecycleExecutor.execute {
            try {
                if (!ensureNativeLoaded()) {
                    // No native library in this APK: fail closed so a mis-flagged build goes
                    // OFFLINE, never clearnet (matching UnavailableTorBackend on the TS side).
                    emitError("StiqArti native library not present in this build")
                    startPromise?.reject("arti_not_built", "StiqArti native library not present")
                    startPromise = null
                    return@execute
                }
                registerNetworkMonitor()
                val rc = artiStart(json) // >0 = bound SOCKS port; <0 = codes::* from lib.rs
                if (rc > 0) {
                    lastHttpPort = artiHttpPort()
                } else if (startPromise != null) {
                    // Rust emits 'error' (and therefore settles the promise) before returning, so
                    // reaching here means it failed without saying why. Settle it regardless — a
                    // promise that never resolves would hang the connect ladder forever.
                    val msg = "arti_start failed with code $rc"
                    emitError(msg)
                    startPromise?.reject("arti_start_failed", msg)
                    startPromise = null
                }
            } catch (e: Throwable) {
                android.util.Log.e("StiqArti", "startTor failed", e)
                emitError(e.message ?: "arti_start failed")
                startPromise?.reject("arti_start_failed", e.message ?: "arti_start failed")
                startPromise = null
            }
        }
    }

    /**
     * Install reach credentials into the LIVE daemon and kick the deferred reachability
     * verification — the second half of an early start (one made before the JS runtime hydrated
     * the active community; see arti-ffi/src/lib.rs arti_install_auth). Arti reads its keystore at
     * descriptor-fetch time, so unlike C-tor no restart is needed to pick a credential up.
     *
     * Routed through the SAME lifecycleExecutor as start/stop so it can never interleave with an
     * in-flight start (the keystore write needs the client the start is still creating).
     */
    @ReactMethod
    fun installReach(config: ReadableMap, promise: Promise) {
        val root = JSONObject()
        config.getString("relayOnion")?.let { root.put("relayOnion", it) }
        config.getMap("onionAuth")?.let { root.put("onionAuth", authToJson(it)) }
        config.getArray("onionAuthExtra")?.let { extra ->
            val arr = JSONArray()
            for (i in 0 until extra.size()) {
                extra.getMap(i)?.let { arr.put(authToJson(it)) }
            }
            root.put("onionAuthExtra", arr)
        }
        val json = root.toString()
        lifecycleExecutor.execute {
            try {
                if (!ensureNativeLoaded()) {
                    promise.reject("arti_not_built", "StiqArti native library not present")
                    return@execute
                }
                val rc = artiInstallAuth(json)
                if (rc == 0) {
                    promise.resolve(null)
                } else {
                    promise.reject("arti_install_auth_failed", "artiInstallAuth failed with code $rc")
                }
            } catch (e: Throwable) {
                android.util.Log.e("StiqArti", "installReach failed", e)
                promise.reject("arti_install_auth_failed", e.message ?: "installReach failed")
            }
        }
    }

    @ReactMethod
    fun stopTor(promise: Promise) {
        unregisterNetworkMonitor()
        lifecycleExecutor.execute {
            try {
                // Drops the TorClient and tears the SOCKS server down; Rust emits 'stopped' itself.
                if (nativeLoaded) artiStop() else emitStopped()
            } catch (e: Throwable) {
                android.util.Log.e("StiqArti", "stopTor failed", e)
                // Never leave the JS layer believing Tor is still up.
                emitStopped()
            }
            lastHttpPort = -1
            promise.resolve(null)
        }
    }

    /**
     * Rotate identity. Arti has no global NEWNYM; `arti_new_identity` retires the onion circuit pool
     * so every subsequent `.onion` connection builds a fresh rendezvous circuit (see lib.rs for how
     * that compares to C-tor's signal — for STIQ, which only ever dials onions, it is equivalent).
     */
    @ReactMethod
    fun newCircuit(promise: Promise) {
        lifecycleExecutor.execute {
            try {
                if (nativeLoaded) artiNewIdentity()
            } catch (e: Throwable) {
                android.util.Log.w("StiqArti", "newCircuit failed", e)
            }
            promise.resolve(null)
        }
    }

    /**
     * SIGNAL DORMANT / SIGNAL ACTIVE equivalents — see `dormancy.ts`, which calls these while the app
     * is backgrounded so the daemon idles instead of being killed and cold-restarted.
     *
     * Fire-and-forget by contract (`TorDaemonControl.setDormant?: () => void`), and NOT routed
     * through the lifecycleExecutor: they must take effect the moment the app backgrounds, and
     * queueing them behind an in-flight start would defeat the point. `set_dormant` on the Rust side
     * only touches an already-built client, so there is no lifecycle race to serialize against.
     */
    @ReactMethod
    fun setDormant() {
        try {
            if (nativeLoaded) artiSetDormant(true)
        } catch (e: Throwable) {
            android.util.Log.w("StiqArti", "setDormant failed", e)
        }
    }

    @ReactMethod
    fun setActive() {
        try {
            if (nativeLoaded) artiSetDormant(false)
        } catch (e: Throwable) {
            android.util.Log.w("StiqArti", "setActive failed", e)
        }
    }

    /** HTTP CONNECT proxy port for the opt-in full-page WebView, or -1 when Arti exposes none
     *  (Arti has no HTTP front — StiqWebProxy must fall back to reader-mode). */
    @ReactMethod
    fun getHttpTunnelPort(promise: Promise) {
        promise.resolve(lastHttpPort)
    }

    /**
     * Coarse transport class of the current default network (formerly identical to the now-deleted
     * StiqTorModule's method of the same name).
     *
     * `daemonControl.ts::getNetworkClass()` reads this off `NativeModules.StiqArti` — the only Tor
     * engine now that C-tor/StiqTorModule/StiqTorPackage are gone. The answer itself comes from
     * ConnectivityManager and has nothing to do with which Tor engine is running; it just needs to be
     * read off whichever native module is actually registered.
     */
    @ReactMethod
    fun getNetworkClass(promise: Promise) {
        promise.resolve(currentNetworkClass())
    }

    @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}
    @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}

    // ── Default-network monitor (mirrors StiqTorModule) ───────────────────────────────────────────

    private fun registerNetworkMonitor() {
        if (connectivityCallback != null) return
        val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val prev = lastNetwork
                lastNetwork = network
                // The first callback after registering is the baseline; only a genuine change of
                // the default network nudges JS.
                if (prev != null && prev != network) emitNetworkChanged()
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            connectivityCallback = cb
        } catch (_: Exception) {
            connectivityCallback = null
        }
    }

    private fun unregisterNetworkMonitor() {
        val cb = connectivityCallback ?: return
        connectivityCallback = null
        lastNetwork = null
        val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        try { cm.unregisterNetworkCallback(cb) } catch (_: Exception) {}
    }

    /**
     * Reads ONLY the transport TYPE from NetworkCapabilities — never SSID/BSSID/WifiInfo — so it
     * needs no location permission and cannot fingerprint the specific network. VPN is reported
     * first so a Wi-Fi/cellular underlay behind a VPN still classifies as "vpn".
     */
    private fun currentNetworkClass(): String {
        val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return "unknown"
        val active = cm.activeNetwork ?: return "unknown"
        val caps = cm.getNetworkCapabilities(active) ?: return "unknown"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    // ── Config marshaling (ReadableMap → the S1 JSON string) ──────────────────────────────────────

    /**
     * Build the single JSON string arti_start consumes, mirroring TorStartConfig
     * (client/src/tor/types.ts) and ffi.rs::TorStartConfigJson. Passes the raw privKeyBase32 through
     * for BOTH onionAuth and every onionAuthExtra entry — the Rust side (onion_auth.rs) validates +
     * decodes, and the Kotlin module does NOT write any C-tor `<host>.auth_private` file (that format
     * is dead for Arti).
     */
    private fun buildConfigJson(config: ReadableMap, fallbackDataDir: String, nativeLibDir: String): String {
        val root = JSONObject()
        root.put("transport", config.getString("transport") ?: "direct")
        root.put("bridgeLines", readStringArray(config.getArray("bridgeLines")))
        root.put("socksPort", if (config.hasKey("socksPort")) config.getInt("socksPort") else 0)
        // Honor a caller-supplied dataDir when present, mirroring relayOnion below — this hand-copy
        // used to ignore config's own "dataDir" key and write the computed ArtiState path
        // unconditionally, so a TS-supplied TorStartConfig.dataDir could never reach Rust. Unlike
        // relayOnion this key can never be omitted: ffi.rs::build_config hard-requires dataDir, so
        // fall back to the computed path rather than dropping the key when the caller has none.
        val dataDir = config.getString("dataDir")?.takeIf { it.isNotBlank() } ?: fallbackDataDir
        root.put("dataDir", dataDir)
        root.put("nativeLibDir", nativeLibDir)
        // The reachability probe's target host. `onionAuth` is absent for PUBLIC communities, so
        // keying the probe off it alone left public users still hitting the false-`connected` bug:
        // arti reports bootstrap 100% off a cached consensus with zero usable guards, the ladder
        // accepts that as rung success and parks on a dead rung. ffi.rs prefers `relayOnion` over
        // `onionAuth.onionHost` when both are present. This hand-copy only forwards keys it names,
        // so a field added to TorStartConfig and parsed by ffi.rs is silently dropped here unless
        // it also gets a line — which is exactly how this one was inert in the first place.
        config.getString("relayOnion")?.let { root.put("relayOnion", it) }
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

    /** Kinds that carry no payload beyond their name ('verified'). */
    private fun emitKindOnly(kind: String) =
        emit(WritableNativeMap().apply { putString("kind", kind) })

    private fun emitTransportDead(message: String) =
        emit(WritableNativeMap().apply {
            putString("kind", "transport-dead")
            putString("message", message)
        })

    private fun emitStopped() =
        emit(WritableNativeMap().apply { putString("kind", "stopped") })

    /**
     * A dedicated channel (separate from Tor status) for default-network-change nudges, with the
     * same event name and payload StiqTorModule uses so App.tsx's existing listener works unchanged.
     */
    private fun emitNetworkChanged() {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(
                    "StiqTorNetworkChange",
                    WritableNativeMap().apply { putString("networkClass", currentNetworkClass()) },
                )
        } catch (_: Exception) {}
    }
}
