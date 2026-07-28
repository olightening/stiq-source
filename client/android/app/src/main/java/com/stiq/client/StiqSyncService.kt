package com.stiq.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.PowerManager
import androidx.annotation.RequiresApi
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.modules.core.DeviceEventManagerModule

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

    // ── Android 15 dataSync foreground-service timeout ────────────────────────────────────────────
    //
    // See the TOR-NATIVE-1 tripwire in android/build.gradle. On API 35+, an app targeting SDK 35+
    // may run dataSync foreground services for a cumulative 6h per 24h; when that budget elapses the
    // system calls onTimeout, drops our foreground status, and gives us "a few seconds" to stop
    // before killing the process with
    //   RemoteServiceException: A foreground service of type dataSync did not stop within its timeout
    //
    // These overrides are inert until targetSdkVersion is raised to 35+ — enforcement is gated on
    // the APP's target, not the device's OS level. Both overloads exist in android.jar 35 and both
    // are declared here because the framework picks by call site: shortService timeouts arrive at
    // onTimeout(startId), and typed timeouts (dataSync, mediaProcessing) arrive at
    // onTimeout(startId, fgsType). Implementing only one leaves a live crash path.
    //
    // WHY WE DO NOT SIMPLY stopSelf() AND WALK AWAY, AND WHY WE DO NOT FIGHT TO STAY ALIVE:
    //
    // The in-flight work here is the `StiqBackgroundSync` headless JS task, which may be holding the
    // in-process Arti Tor client. Killing that client without going through TorManager.disconnect()
    // → StiqArti.stopTor() → arti_stop() leaves arti's tokio tasks running and its
    // `state/state.lock` held, which breaks EVERY subsequent Tor start — a bug this project has
    // already paid for once. So a hard teardown from native is out.
    //
    // The saving grace is that React Native's HeadlessJsTaskService.onDestroy() does NOT tear down
    // the React context and does NOT cancel a running JS task: it only unregisters the task-event
    // listener and releases RN's wake lock. So stopping the *service* leaves the JS task running to
    // completion inside the same process, and the task unwinds through its own `finally` — which is
    // exactly the clean Arti shutdown path. Our job is therefore only to (a) get out of the
    // foreground fast enough to avoid the ANR, and (b) make sure that unwind actually gets to run.
    //
    // Hence, in order:
    //   1. Remember the exhaustion (StiqFgsBudget) so nothing re-attempts a promotion the OS will
    //      refuse, and so the UnifiedPush receiver stops arming a startForegroundService deadline.
    //   2. Take our OWN short PARTIAL_WAKE_LOCK. RN's onDestroy releases its wake lock (it is
    //      non-reference-counted), so without this the CPU could sleep with the drain — and the
    //      arti shutdown — half finished.
    //   3. Ask JS to abort NOW rather than run out its own 85s wall, via STIQ_SYNC_TIMEOUT_EVENT.
    //      syncTask.ts already polls an abort flag every 500ms inside the drain, so this turns a
    //      potential ~85s unwind into a ~1-3s one.
    //   4. Drop foreground status and stop. Nothing above blocks, so this lands well inside the
    //      few-second deadline.
    //
    // The resumption path needs no new scheduling: the unique periodic `stiq_background_sync`
    // WorkManager request (StiqWorkManagerModule) is untouched by an FGS timeout and fires again on
    // its normal ~15-minute jittered window. It runs SyncWorker → plain startService(), which is not
    // subject to the promotion deadline, so post-timeout syncs still work — just unpromoted, i.e.
    // with a lower kill priority. Nothing is lost permanently: the cache drain is incremental
    // (`since`-based) and best-effort by design, exactly as it already is under Doze/App-Standby.

    /** shortService timeouts (API 34+). Routed to the same handler for safety. */
    @RequiresApi(34)
    override fun onTimeout(startId: Int) {
        handleFgsTimeout(startId, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    /** Typed FGS timeouts (API 35+) — this is the one dataSync actually arrives on. */
    @RequiresApi(FGS_TIMEOUT_SDK)
    override fun onTimeout(startId: Int, fgsType: Int) {
        handleFgsTimeout(startId, fgsType)
    }

    private fun handleFgsTimeout(startId: Int, fgsType: Int) {
        android.util.Log.w(
            "StiqSyncService",
            "FGS timeout (startId=$startId, type=$fgsType): dataSync budget exhausted; " +
                "stopping and asking the headless sync to unwind cleanly",
        )
        StiqFgsBudget.markDataSyncExhausted(this)
        holdCpuForCleanUnwind()
        requestJsUnwind()
        clearForeground()
        // stopSelf(), NOT stopSelf(startId): the id form is a no-op if a newer start command has
        // arrived, which would leave us foregrounded past the deadline and crash the process.
        stopSelf()
    }

    /**
     * Keep the CPU up briefly so the JS task's `finally` (relay close, SQLite close, secret-key
     * scrub, and the Arti disconnect) actually completes after we surrender foreground status.
     * Timed acquire, so it self-releases even if this process is torn down first.
     */
    private fun holdCpuForCleanUnwind() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
            lock.setReferenceCounted(false)
            lock.acquire(UNWIND_WAKE_LOCK_MS)
            unwindWakeLock = lock
        } catch (t: Throwable) {
            android.util.Log.w("StiqSyncService", "unwind wake lock failed", t)
        }
    }

    /**
     * Best-effort nudge to the running JS task. No live React context (or no listener registered)
     * simply means the task falls back to its own 85s wall — correct, just slower.
     */
    private fun requestJsUnwind() {
        try {
            val reactContext = getReactContext() ?: return
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(STIQ_SYNC_TIMEOUT_EVENT, null)
        } catch (t: Throwable) {
            android.util.Log.w("StiqSyncService", "could not signal JS on FGS timeout", t)
        }
    }

    private fun promoteToForeground() {
        // Post-timeout, startForeground(dataSync) throws ForegroundServiceStartNotAllowedException
        // ("Time limit already exhausted"). Skip it. SAFETY INVARIANT: this early return is only
        // sound because nothing calls startForegroundService() for this service while the budget is
        // exhausted — StiqUnifiedPushReceiver checks the same flag, and SyncWorker always uses plain
        // startService(). Break that and the 5s promotion deadline fires instead.
        if (StiqFgsBudget.isDataSyncExhausted(this)) {
            android.util.Log.w(
                "StiqSyncService",
                "dataSync FGS budget exhausted — running this sync without foreground promotion",
            )
            return
        }
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

        private const val WAKE_LOCK_TAG = "stiq:sync-timeout-unwind"

        /**
         * How long to keep the CPU up after an FGS timeout so the JS task can unwind. Generous
         * enough for a relay close + SQLite close + arti_stop() (~1-3s once the abort event lands),
         * short enough that a stuck task cannot hold the CPU meaningfully. Timed acquire, so it
         * always self-releases.
         */
        private const val UNWIND_WAKE_LOCK_MS = 20_000L

        /** Held statically so the timed release survives this Service instance being destroyed. */
        @Volatile
        private var unwindWakeLock: PowerManager.WakeLock? = null
    }
}
