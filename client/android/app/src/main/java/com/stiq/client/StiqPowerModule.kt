package com.stiq.client

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * StiqPower — battery-optimization exemption + OEM vendor info (W3, Tor stability+speed).
 *
 * Android's Doze/App-Standby battery optimizer (and OEM-specific task killers on top of it) is a
 * leading cause of the background Tor daemon getting silently frozen/killed, which the rest of the
 * W1-W4 workstream depends on staying alive. This module lets the JS side (1) check whether Stiq is
 * already exempted from battery optimization, (2) fire the OS's own "ignore battery optimizations"
 * request dialog for this app, and (3) read the device manufacturer/brand/model so the JS side can
 * show OEM-specific extra-step guidance (MIUI Autostart, Huawei Protected apps, etc. — those OEM
 * settings are NOT part of stock Android and have no API; the app can only tell the user where to
 * look).
 *
 * Every method is guarded so an old API level, a missing activity, or a denied intent never crashes
 * the app — worst case they resolve/no-op and the JS wrapper (reliability.ts) treats that as "can't
 * tell, assume fine" so the reliability prompt degrades gracefully instead of nagging incorrectly.
 */
class StiqPowerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqPower"

    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                // No battery-optimization concept before Marshmallow — nothing to exempt from.
                promise.resolve(true)
                return
            }
            val ctx = reactApplicationContext
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            promise.resolve(pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: true)
        } catch (e: Exception) {
            promise.reject("POWER_ERROR", e)
        }
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations() {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                return // nothing to request pre-Marshmallow
            }
            val ctx = reactApplicationContext
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${ctx.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            // Prefer the foreground activity (no task-switch animation); fall back to the app
            // context (already carries FLAG_ACTIVITY_NEW_TASK above) if none is attached.
            val launcher = currentActivity ?: ctx
            launcher.startActivity(intent)
        } catch (e: Exception) {
            // Some OEM builds/ROMs strip this action from the Settings app entirely — degrade to a
            // silent no-op rather than crashing; the JS side re-checks the exemption state anyway.
        }
    }

    @ReactMethod
    fun getDeviceVendorInfo(promise: Promise) {
        try {
            val map = Arguments.createMap()
            map.putString("manufacturer", Build.MANUFACTURER ?: "")
            map.putString("brand", Build.BRAND ?: "")
            map.putString("model", Build.MODEL ?: "")
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("POWER_ERROR", e)
        }
    }
}
