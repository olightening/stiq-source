package com.stiq.client

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.unifiedpush.android.connector.UnifiedPush

/** SharedPreferences file + key the receiver writes the endpoint into and this module reads back. */
internal const val STIQ_PUSH_PREFS = "stiq_push"
internal const val STIQ_PUSH_KEY_ENDPOINT = "endpoint"
/** RCTDeviceEventEmitter channel the receiver emits on when a React context happens to be live. */
internal const val STIQ_PUSH_EVENT = "StiqPushEvent"

/**
 * StiqUnifiedPush — the Android half of STIQ's content-free push wake (T1).
 *
 * Push in STIQ is a WAKE signal, never content delivery: a UnifiedPush distributor (e.g. the ntfy
 * app + Orbot — NO FCM/Google Play Services) delivers an EMPTY message; [StiqUnifiedPushReceiver]
 * catches it and starts the SAME [StiqSyncService] headless task WorkManager already uses, which
 * derives any title-only notification locally over Tor. This module is only the JS↔native control
 * surface: opt-in registration, distributor lookup, and reading back the endpoint the receiver
 * persisted (so JS can register with the watcher even if the endpoint arrived while JS was dead).
 *
 * Everything here is inert until JS opts in (gated on config PUSH_UNIFIEDPUSH + a relay-advertised
 * watcher + a distributor being installed); with no distributor, registerApp() resolves
 * "no_distributor" and the app stays on the unchanged WorkManager polling default.
 */
class StiqUnifiedPushModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqUnifiedPush"

    /**
     * Register with a UnifiedPush distributor. A distributor (the on-device push app) must be chosen
     * before UnifiedPush.register() has anywhere to deliver: reuse a saved one, else auto-pick the
     * first available. With NONE installed there is nothing to register against — resolve
     * "no_distributor" so JS silently falls through to WorkManager polling.
     */
    @ReactMethod
    fun registerApp(promise: Promise) {
        try {
            val ctx: Context = reactApplicationContext
            if (UnifiedPush.getSavedDistributor(ctx) == null) {
                val available = UnifiedPush.getDistributors(ctx)
                if (available.isEmpty()) {
                    promise.resolve("no_distributor")
                    return
                }
                UnifiedPush.saveDistributor(ctx, available.first())
            }
            // Endpoint arrives asynchronously via the receiver's onNewEndpoint → persisted +
            // (best-effort) STIQ_PUSH_EVENT; JS also cold-reads it with getEndpoint().
            UnifiedPush.register(ctx)
            promise.resolve("registered")
        } catch (e: Exception) {
            promise.reject("PUSH_REGISTER_ERROR", e.message ?: "register failed")
        }
    }

    /** Unregister from the distributor and forget the persisted endpoint. */
    @ReactMethod
    fun unregister(promise: Promise) {
        try {
            val ctx: Context = reactApplicationContext
            UnifiedPush.unregister(ctx)
            ctx.getSharedPreferences(STIQ_PUSH_PREFS, Context.MODE_PRIVATE)
                .edit().remove(STIQ_PUSH_KEY_ENDPOINT).apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("PUSH_UNREGISTER_ERROR", e.message ?: "unregister failed")
        }
    }

    /** The saved distributor package name, or null if none has been chosen. */
    @ReactMethod
    fun getDistributor(promise: Promise) {
        try {
            promise.resolve(UnifiedPush.getSavedDistributor(reactApplicationContext))
        } catch (e: Exception) {
            promise.reject("PUSH_DISTRIBUTOR_ERROR", e.message ?: "distributor lookup failed")
        }
    }

    /**
     * The push endpoint URL the receiver last persisted, or null. Read from SharedPreferences (NOT
     * live state) so a cold-started JS layer can register with the watcher even when the endpoint
     * broadcast arrived while the app process was dead.
     */
    @ReactMethod
    fun getEndpoint(promise: Promise) {
        try {
            val ep = reactApplicationContext
                .getSharedPreferences(STIQ_PUSH_PREFS, Context.MODE_PRIVATE)
                .getString(STIQ_PUSH_KEY_ENDPOINT, null)
            promise.resolve(ep)
        } catch (e: Exception) {
            promise.reject("PUSH_ENDPOINT_ERROR", e.message ?: "endpoint lookup failed")
        }
    }

    // NativeEventEmitter bookkeeping (JS subscribes to STIQ_PUSH_EVENT). No-ops, mirroring
    // StiqTorModule: the receiver emits opportunistically only when a context is live.
    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}
}
