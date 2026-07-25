package com.stiq.client

import android.content.Context
import android.content.Intent
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * WorkManager worker that fires the JS headless background-sync task (PLAN.md Obj. 4).
 *
 * Wakes the app periodically (~15-min jittered via PeriodicWorkRequest flex window), starts
 * StiqSyncService which runs the JS `StiqBackgroundSync` headless task, then exits.
 * StiqSyncService owns its own lifecycle: it calls stopSelf() after the task completes or
 * the hard 90-second timeout elapses. This worker returns success immediately so WorkManager
 * doesn't count service lifetime against its own deadline.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val intent = Intent(applicationContext, StiqSyncService::class.java)
        try {
            applicationContext.startService(intent)
        } catch (_: Exception) {
            // App may be in a state where startService is blocked (e.g. Android 12+ background
            // restrictions). Return success so WorkManager reschedules rather than retrying
            // immediately — we'll get another shot on the next jittered window.
        }
        return Result.success()
    }
}
