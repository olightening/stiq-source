package com.stiq.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * HeadlessJsTaskService that launches the `StiqBackgroundSync` JS task (PLAN.md Obj. 4).
 *
 * Started by SyncWorker when the periodic WorkManager alarm fires, and by StiqUnifiedPushReceiver on a
 * content-free push wake. React Native runs the registered headless task in a JS context with no UI —
 * it connects Tor, drains the relay to EOSE, persists new events to the encrypted SQLite cache, then
 * disconnects.
 *
 * The 90-second task timeout matches the hard wall-clock bound enforced by the JS task itself.
 * `allowedInForeground = false` means RN skips the task when the app is already in the foreground (the
 * main connection loop handles sync there).
 *
 * Foreground-service contract (W2 change 3): StiqUnifiedPushReceiver starts this via
 * startForegroundService() (so it can wake from a killed/background state on API 26+). A service
 * started that way MUST call startForeground() within ~5s or the OS kills the process with
 * ForegroundServiceDidNotStartInTimeException. This service previously NEVER called it. onCreate() now
 * calls startForeground() immediately with a silent IMPORTANCE_MIN notification, and the notification
 * is removed via stopForeground(STOP_FOREGROUND_REMOVE) when the headless task finishes.
 */
class StiqSyncService : HeadlessJsTaskService() {

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        return HeadlessJsTaskConfig(
            "StiqBackgroundSync",
            Arguments.createMap(),
            90_000L,  // hard wall — JS task self-enforces same limit
            false,    // not allowed in foreground (main loop is live) — see onStartCommand
        )
    }

    /**
     * Promote to foreground BEFORE anything else: onCreate runs before onStartCommand, so calling
     * startForeground here always satisfies the startForegroundService deadline (even on the
     * IllegalStateException skip path below, which would otherwise stopSelf() without ever promoting
     * and trip ForegroundServiceDidNotStartInTimeException). Guarded — a background-start restriction
     * (Android 12+) must never crash the process; if it throws, the task still runs, just without the
     * notification (it was only started via plain startService in that case, so there is no deadline).
     */
    override fun onCreate() {
        super.onCreate()
        try {
            promoteToForeground()
        } catch (t: Throwable) {
            android.util.Log.w("StiqSyncService", "startForeground failed; continuing without FGS notification", t)
        }
    }

    /**
     * `allowedInForeground = false` does NOT make RN silently skip the task: React Native's
     * HeadlessJsTaskService.startTask() THROWS IllegalStateException ("Tried to start task ... while
     * in foreground, but this is not allowed.") when the app is foregrounded. WorkManager's periodic
     * SyncWorker can fire in the exact window the app is (re)entering the foreground — e.g. right at
     * cold launch, before App.tsx's workManager.cancelSync() lands — so that throw would crash the
     * whole process. The foreground main connection loop already syncs, so swallow it and stop: skip
     * this one background run instead of taking the app down. startForeground was already called in
     * onCreate, so stopping here is clean (no FGS-timeout crash); remove the notification first.
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return try {
            super.onStartCommand(intent, flags, startId)
        } catch (e: IllegalStateException) {
            clearForeground()
            stopSelf(startId)
            START_NOT_STICKY
        }
    }

    /**
     * Called by RN when a headless task completes. super stops the service when the last task ends;
     * remove the foreground notification as the task is done. (Only StiqBackgroundSync runs here, so
     * one finish == all done.)
     */
    override fun onHeadlessJsTaskFinish(taskId: Int) {
        super.onHeadlessJsTaskFinish(taskId)
        clearForeground()
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
            .setContentTitle(getString(R.string.stiq_sync_notification))
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

    private fun clearForeground() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Exception) {}
    }

    private fun ensureChannel(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.stiq_sync_channel),
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
        private const val CHANNEL_ID = "stiq_sync"
        // Distinct from StiqTorService's foreground notification id.
        private const val NOTIFICATION_ID = 9052
    }
}
