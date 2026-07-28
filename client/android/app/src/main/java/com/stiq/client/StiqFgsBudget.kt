package com.stiq.client

import android.content.Context
import android.os.Build

/**
 * The API level at which Android arms the `dataSync` foreground-service timeout budget.
 * Android 15 = API 35 (Build.VERSION_CODES.VANILLA_ICE_CREAM); spelled as a literal so this file
 * compiles unchanged against any compileSdk.
 */
internal const val FGS_TIMEOUT_SDK = 35

/**
 * Event emitted to JS when StiqSyncService is force-stopped by the Android 15 `dataSync` FGS
 * timeout. The JS background-sync task should treat it exactly like a foreground reclaim: call
 * `requestBackgroundSyncAbort()` so the drain's abort checkpoint fires and the task unwinds through
 * its own `finally` (which is what calls `manager.disconnect()` → `StiqArti.stopTor()`).
 */
internal const val STIQ_SYNC_TIMEOUT_EVENT = "StiqSyncServiceTimeout"

private const val FGS_PREFS = "stiq_fgs"
private const val KEY_DATA_SYNC_TIMED_OUT_AT = "dataSyncTimedOutAt"

/** The budget window Android tracks dataSync FGS runtime over (6h of runtime per rolling 24h). */
private const val BUDGET_WINDOW_MS = 24L * 60L * 60L * 1000L

/**
 * Tracks whether this app has burned its Android 15 `dataSync` foreground-service budget.
 *
 * Why this exists at all: on Android 15+ (API 35), an app whose **targetSdkVersion** is >= 35 may
 * run `dataSync`-type foreground services for a cumulative 6 hours per 24-hour window. When that
 * budget is exhausted the system calls `Service.onTimeout(...)`, and from that moment:
 *
 *   - the service is no longer a foreground service and MUST stop itself within a few seconds, or
 *     the system throws `RemoteServiceException: A foreground service of type dataSync did not stop
 *     within its timeout`;
 *   - **any subsequent `startForeground(..., FOREGROUND_SERVICE_TYPE_DATA_SYNC)` throws**
 *     `ForegroundServiceStartNotAllowedException: Time limit already exhausted for foreground
 *     service type dataSync`, until the user brings the app to the foreground (which resets the
 *     system's timer) or the 24h window rolls.
 *
 * That second half is the dangerous one: without this flag, every later WorkManager/UnifiedPush
 * wake would re-attempt a promotion the OS is guaranteed to refuse. Worse, a wake started via
 * `startForegroundService()` that then fails to promote trips the *other* fatal exception
 * (`ForegroundServiceDidNotStartInTimeException`). So the flag is consulted in two places:
 *
 *   1. [StiqSyncService.promoteToForeground] — skip the doomed promotion entirely.
 *   2. [StiqUnifiedPushReceiver.onMessage] — start the service with plain `startService()` instead
 *      of `startForegroundService()`, so no 5-second promotion deadline is ever armed.
 *
 * Those two must stay in agreement: whenever this returns true, NOTHING may call
 * `startForegroundService()` for [StiqSyncService].
 *
 * Nothing here does anything today — `targetSdkVersion` is pinned at 34 by the tripwire in
 * `android/build.gradle`, so `onTimeout` never fires and the flag is never set. It is the
 * pre-requisite for lifting that pin.
 */
internal object StiqFgsBudget {

    /** Record that the system just timed out our dataSync FGS. Called only from `onTimeout`. */
    fun markDataSyncExhausted(context: Context) {
        try {
            prefs(context).edit()
                .putLong(KEY_DATA_SYNC_TIMED_OUT_AT, System.currentTimeMillis())
                .apply()
        } catch (_: Throwable) {
            // A prefs write must never be the thing that keeps us from stopping inside the
            // few-second onTimeout deadline. Worst case we retry a promotion the OS refuses, which
            // the caller already catches.
        }
    }

    /**
     * True while a `startForeground(dataSync)` is expected to be refused by the OS.
     *
     * Self-healing on three axes so a stuck flag can never permanently demote background sync:
     * a device below API 35 can't have the budget at all; a stamp older than the 24h window has
     * rolled off; and a stamp in the future (user moved the clock back) is discarded.
     */
    fun isDataSyncExhausted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < FGS_TIMEOUT_SDK) {
            return false
        }
        return try {
            val at = prefs(context).getLong(KEY_DATA_SYNC_TIMED_OUT_AT, 0L)
            if (at == 0L) {
                return false
            }
            val age = System.currentTimeMillis() - at
            if (age < 0L || age > BUDGET_WINDOW_MS) {
                clear(context)
                false
            } else {
                true
            }
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Clear the flag. Called from `MainActivity.onResume`: the platform resets the dataSync timer
     * when the user brings the app to the foreground, so our mirror of that state must reset with
     * it — otherwise the very next background wake after a normal app session would needlessly run
     * unpromoted for up to 24 hours.
     */
    fun clear(context: Context) {
        try {
            prefs(context).edit().remove(KEY_DATA_SYNC_TIMED_OUT_AT).apply()
        } catch (_: Throwable) {
        }
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(FGS_PREFS, Context.MODE_PRIVATE)
}
