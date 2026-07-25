package com.stiq.client

import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.TimeUnit
import kotlin.random.Random

private const val SYNC_WORK_NAME = "stiq_background_sync"

/**
 * React Native bridge module for scheduling and cancelling the periodic background sync
 * (PLAN.md Obj. 4). The JS side calls scheduleSync() when the app backgrounds and
 * cancelSync() when it comes back to the foreground.
 */
class StiqWorkManagerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqWorkManager"

    /**
     * Schedule a jittered periodic sync. intervalMinutes is the target period (min 15, OS
     * enforced); flexMinutes is the flex window within which it can fire (provides jitter that
     * defeats fixed-schedule timing correlation). On top of that flex window and the JS-side
     * randomized interval, we add a random 0..flex-minute initialDelay so the FIRST fire after a
     * background→schedule is itself unpredictable (first-fire jitter): two devices backgrounding at
     * the same instant don't wake in lock-step. KEEP policy means a live request survives multiple
     * foreground→background cycles without stacking — and because cancelSync() on foreground clears
     * the unique work, each fresh background schedule re-rolls both the interval and this delay.
     *
     * iOS parity is intentionally deferred: client/ios StiqWorkManager is scaffold-only (BGTask
     * polling), so this Android-only jitter has no iOS counterpart to keep in sync.
     */
    @ReactMethod
    fun scheduleSync(intervalMinutes: Int, flexMinutes: Int) {
        val interval = intervalMinutes.toLong().coerceAtLeast(15L)
        val flex = flexMinutes.toLong().coerceAtLeast(5L)
        // First-fire jitter: 0..flex minutes (expressed in seconds), independent of the flex window.
        val initialDelaySec = Random.nextLong(0, flex * 60 + 1)

        val request = PeriodicWorkRequestBuilder<SyncWorker>(interval, TimeUnit.MINUTES, flex, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    // A sync needs the network (Tor bootstrap + relay). Without this, WorkManager fires
                    // with zero connectivity and wastes a full RN context + Tor bootstrap attempt.
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .setInitialDelay(initialDelaySec, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(reactContext).enqueueUniquePeriodicWork(
            SYNC_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /** Cancel any pending or scheduled background sync. Called when the app foregrounds. */
    @ReactMethod
    fun cancelSync() {
        WorkManager.getInstance(reactContext).cancelUniqueWork(SYNC_WORK_NAME)
    }
}
