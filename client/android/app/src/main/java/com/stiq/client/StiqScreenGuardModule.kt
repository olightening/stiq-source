package com.stiq.client

import android.os.Build
import android.view.View
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * StiqScreenGuard — JS control over the two window-level hardening flags MainActivity sets.
 *
 * `MainActivity.applyScreenGuards()` already turns FLAG_SECURE on app-wide (and, on API 31+,
 * `setHideOverlayWindows(true)`) before the first frame, so the Recents/task-switcher thumbnail is
 * protected without JS doing anything. This module exists for the two cases the app-wide default
 * cannot express:
 *
 *   - [setSecure] — a deliberate, user-initiated export that legitimately needs a screenshot
 *     (saving an invite QR, for instance). JS drops FLAG_SECURE for that interaction and restores
 *     it immediately after. Restoring is the caller's responsibility; there is no auto-restore,
 *     because guessing when the flow ended is exactly how such a guard silently stays off.
 *
 *   - [setTapjackGuard] — `View.setFilterTouchesWhenObscured(true)` on the Activity's content root.
 *     `ViewGroup.dispatchTouchEvent` consults `onFilterTouchEventForSecurity` before dispatching to
 *     children, so setting it on the content root protects the ENTIRE view subtree, including every
 *     React Native view inside it. This is the pre-API-31 answer to tapjacking (there is no
 *     `setHideOverlayWindows` below Android 12) and a second layer above it.
 *
 *     It is NOT applied app-wide and NOT permanently, on purpose: touch filtering drops touches
 *     whenever the framework marks the event as obscured, and on older releases same-app windows
 *     (system Toasts in particular) could set that flag. Blanket-enabling it risks silently eating
 *     legitimate taps across the whole app. Scoped to PIN entry and destructive confirmations, the
 *     trade is clearly worth it; app-wide it is not.
 *
 * Every method is a no-op when there is no attached Activity (backgrounded, or mid-teardown) rather
 * than throwing — a hardening toggle must never be able to crash the app it is protecting.
 */
class StiqScreenGuardModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqScreenGuard"

    /**
     * Add or clear FLAG_SECURE on the Activity window. Must run on the UI thread; changing this
     * flag recreates the window surface, so expect a frame of flicker on the toggle.
     */
    @ReactMethod
    fun setSecure(secure: Boolean) {
        UiThreadUtil.runOnUiThread {
            try {
                val window = currentActivity?.window ?: return@runOnUiThread
                if (secure) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
            } catch (t: Throwable) {
                android.util.Log.w("StiqScreenGuard", "setSecure failed", t)
            }
        }
    }

    /** Whether FLAG_SECURE is currently set (defaults to the app-wide true when there is no Activity). */
    @ReactMethod
    fun isSecure(promise: Promise) {
        try {
            val window = currentActivity?.window
            if (window == null) {
                promise.resolve(true)
                return
            }
            val flags = window.attributes.flags
            promise.resolve((flags and WindowManager.LayoutParams.FLAG_SECURE) != 0)
        } catch (t: Throwable) {
            promise.resolve(true)
        }
    }

    /**
     * Toggle tapjacking protection (`filterTouchesWhenObscured`) on the Activity's content root.
     * Enable on entering PIN entry or a destructive confirmation; disable on leaving it.
     */
    @ReactMethod
    fun setTapjackGuard(enabled: Boolean) {
        UiThreadUtil.runOnUiThread {
            try {
                val content = currentActivity
                    ?.window
                    ?.decorView
                    ?.findViewById<View>(android.R.id.content)
                    ?: return@runOnUiThread
                content.filterTouchesWhenObscured = enabled
            } catch (t: Throwable) {
                android.util.Log.w("StiqScreenGuard", "setTapjackGuard failed", t)
            }
        }
    }

    /**
     * True when the platform is hiding other apps' overlay windows over ours (API 31+), i.e. when
     * the strong anti-tapjacking guarantee is available and [setTapjackGuard] is only belt-and-
     * braces. JS can use this to decide whether the weaker touch-filtering fallback is worth its
     * false-positive risk on this device.
     */
    @ReactMethod
    fun hasOverlayHiding(promise: Promise) {
        promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
    }
}
