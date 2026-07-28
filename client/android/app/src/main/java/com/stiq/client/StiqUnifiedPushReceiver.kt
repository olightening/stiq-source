package com.stiq.client

import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * StiqUnifiedPushReceiver — the exported broadcast entry point the UnifiedPush distributor delivers
 * to (T1). Declared in AndroidManifest.xml with the four connector actions.
 *
 * Privacy model (see plan T1 architecture): the wake carries ZERO content. onMessage IGNORES the
 * message bytes and simply starts [StiqSyncService], the exact headless task WorkManager runs; the
 * app derives any title-only notification locally over Tor after it wakes. No title, npub, body, or
 * event id ever crosses the distributor/ntfy.
 *
 * The endpoint is persisted to SharedPreferences the instant it arrives so JS can register with the
 * watcher even after a cold start; the STIQ_PUSH_EVENT emit is a best-effort nicety for when a
 * React context is already live.
 */
class StiqUnifiedPushReceiver : MessagingReceiver() {

    override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
        persistEndpoint(context, endpoint.url)
        emitEvent(context, WritableNativeMap().apply {
            putString("type", "endpoint")
            putString("endpoint", endpoint.url)
        })
    }

    override fun onMessage(context: Context, message: PushMessage, instance: String) {
        // Content-free wake: message bytes are deliberately ignored. Start the SAME headless sync
        // WorkManager uses; StiqSyncService owns its own lifecycle and derives notifications locally.
        val intent = Intent(context, StiqSyncService::class.java)
        try {
            // startForegroundService() arms a ~5s deadline for the service to call
            // startForeground(). Once the Android 15 dataSync budget is exhausted (StiqFgsBudget)
            // that promotion is guaranteed to be REFUSED by the OS, so arming the deadline would
            // convert a skippable wake into a fatal ForegroundServiceDidNotStartInTimeException.
            // Fall back to a plain startService(): handling a broadcast temporarily allowlists us
            // from background-start restrictions, so the sync still runs — just unpromoted.
            val canPromote =
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    !StiqFgsBudget.isDataSyncExhausted(context)
            if (canPromote) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (_: Exception) {
            // A background start can be refused in rare states; skip this wake. The WorkManager
            // polling fallback still covers the member — no worse than a member without a distributor.
        }
    }

    override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) {
        clearEndpoint(context)
        emitEvent(context, WritableNativeMap().apply { putString("type", "registrationFailed") })
    }

    override fun onUnregistered(context: Context, instance: String) {
        clearEndpoint(context)
        emitEvent(context, WritableNativeMap().apply { putString("type", "unregistered") })
    }

    private fun persistEndpoint(context: Context, url: String) {
        context.getSharedPreferences(STIQ_PUSH_PREFS, Context.MODE_PRIVATE)
            .edit().putString(STIQ_PUSH_KEY_ENDPOINT, url).apply()
    }

    private fun clearEndpoint(context: Context) {
        context.getSharedPreferences(STIQ_PUSH_PREFS, Context.MODE_PRIVATE)
            .edit().remove(STIQ_PUSH_KEY_ENDPOINT).apply()
    }

    /**
     * Best-effort emit to JS. On a cold wake from a killed process there is NO live React context —
     * that's fine: the endpoint is already persisted and JS cold-reads it via getEndpoint(). When
     * the app is foregrounded, JS receives the event immediately. Wrapped so a bridgeless/no-context
     * state can never crash the broadcast.
     */
    private fun emitEvent(context: Context, body: WritableNativeMap) {
        try {
            val app = context.applicationContext as? ReactApplication ?: return
            val reactContext = app.reactNativeHost.reactInstanceManager.currentReactContext ?: return
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(STIQ_PUSH_EVENT, body)
        } catch (_: Exception) {
        }
    }
}
