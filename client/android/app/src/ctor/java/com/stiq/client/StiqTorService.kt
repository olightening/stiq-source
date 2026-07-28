package com.stiq.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import org.torproject.jni.TorService

/**
 * StiqTorService — a thin subclass of tor-android's [org.torproject.jni.TorService] whose ONLY job is
 * to promote the bundled Tor daemon to a FOREGROUND service with a NEUTRAL, minimal-importance
 * notification (W2 change 4).
 *
 * Why a subclass rather than a resource override: decompiling the bundled AAR
 * (info.guardianproject:tor-android:0.4.8.22) shows [TorService] ships NO res/ and an EMPTY R.txt, and
 * its class contains no startForeground / Notification / NotificationChannel code at all — it is a
 * plain BOUND background service that builds no notification. So there is nothing to override via
 * strings/drawables (the PREFERRED route in the plan is impossible), and there is likewise no
 * notification method to override. The only way to (a) give the daemon a neutral foreground
 * notification and (b) let it survive backgrounding is to make it a foreground service ourselves — the
 * plan's sanctioned fallback. This also makes StiqTorModule's switch to startForegroundService (change
 * 2) safe: a service started via startForegroundService MUST call startForeground within ~5s or the OS
 * throws ForegroundServiceDidNotStartInTimeException; onCreate below does exactly that.
 *
 * Runs in the `:tor` process — that is declared by the AndroidManifest <service android:process=":tor">
 * entry (now pointing at this class), not by the class itself; the class only overrides lifecycle.
 *
 * The data dir is UNCHANGED by subclassing: TorService's internal getAppTorServiceDir() calls
 * `TorService.class.getSimpleName()` on the LITERAL base class (not `getClass()`), so it stays
 * getDir("TorService") = app_TorService regardless of this subclass — the control socket path
 * StiqTorModule hardcodes still resolves.
 *
 * Wording carries NO "Tor" anywhere (threat-model requirement). Channel is IMPORTANCE_MIN, secret on
 * the lock screen, no badge — the quietest persistent notification the OS allows.
 */
class StiqTorService : TorService() {

    override fun onCreate() {
        super.onCreate()
        // Promote to foreground immediately so the startForegroundService deadline is met and the
        // daemon is not a background-killable service. Guarded: a background-start restriction
        // (Android 12+ ForegroundServiceStartNotAllowedException) must never crash the :tor process —
        // if it throws, the service simply continues as a plain bound service, exactly as before W2.
        try {
            promoteToForeground()
        } catch (t: Throwable) {
            android.util.Log.w("StiqTorService", "startForeground failed; continuing as bound service", t)
        }
    }

    private fun promoteToForeground() {
        val channelId = ensureChannel()
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_MIN)
        }
        val notification = builder
            .setContentTitle(getString(R.string.stiq_connection_notification))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setShowWhen(false)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /** Create (idempotently) the IMPORTANCE_MIN channel and return its id. */
    private fun ensureChannel(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.stiq_connection_channel),
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
                enableLights(false)
                enableVibration(false)
            }
            nm.createNotificationChannel(channel)
        }
        return CHANNEL_ID
    }

    companion object {
        private const val CHANNEL_ID = "stiq_connection"
        // Distinct from StiqSyncService's foreground notification id.
        private const val NOTIFICATION_ID = 9051
    }
}
