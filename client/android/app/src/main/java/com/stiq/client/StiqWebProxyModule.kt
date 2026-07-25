package com.stiq.client

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * StiqWebProxyModule — routes the (opt-in) full-page WebView through Tor's HTTPTunnelPort.
 *
 * Android's System WebView uses the OS network stack by default, which would leak the user's
 * real IP the instant a page (or any of its subresources) loads. This module points ALL
 * WebViews at the local Tor HTTP proxy via androidx.webkit ProxyController. Crucially the
 * ProxyConfig has NO `addDirect()` fallback: if the proxy is unreachable the request FAILS
 * rather than silently going clearnet — the same Tor-only posture as the rest of the app.
 *
 * setProxy/clearProxy are process-global; stiq only ever shows one WebView (SafeWebView),
 * which sets the proxy before mounting and clears it on close.
 */
class StiqWebProxyModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqWebProxy"

    @ReactMethod
    fun isSupported(promise: Promise) {
        promise.resolve(WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE))
    }

    @ReactMethod
    fun setProxy(host: String, port: Int, promise: Promise) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            promise.reject("UNSUPPORTED", "WebView PROXY_OVERRIDE not supported on this device")
            return
        }
        if (port <= 0) {
            promise.reject("NO_PORT", "Tor HTTP tunnel port unknown")
            return
        }
        try {
            // Only a proxy rule — NO addDirect(), so nothing falls back to clearnet. And crucially NO
            // loopback bypass, which takes two parts (audit #24):
            //   1. We add no 127.0.0.1/localhost addBypassRule, so nothing is explicitly excluded.
            //   2. removeImplicitRules() strips WebView's DEFAULT implicit bypass of loopback /
            //      localhost / link-local (Chromium's "<-loopback>" token). WITHOUT it those hosts are
            //      still sent DIRECT, so an in-page fetch('http://127.0.0.1:…') could reach and
            //      port-scan device-local services. (It needs only the base PROXY_OVERRIDE feature
            //      checked above — unlike setReverseBypassEnabled, which needs PROXY_OVERRIDE_REVERSE_BYPASS.)
            // With both, loopback subresource requests go to the Tor HTTP proxy, which refuses to connect
            // to a loopback/private address, so they fail closed. The WebView's own connection to the Tor
            // port at $host:$port is the proxy TRANSPORT (governed by the proxy rule, not the bypass
            // list), so it keeps working.
            val config = ProxyConfig.Builder()
                .addProxyRule("$host:$port")
                .removeImplicitRules()
                .build()
            ProxyController.getInstance().setProxyOverride(config, { it.run() }) {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.reject("PROXY_ERROR", e.message ?: "failed to set proxy")
        }
    }

    @ReactMethod
    fun clearProxy(promise: Promise) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            promise.resolve(null)
            return
        }
        try {
            ProxyController.getInstance().clearProxyOverride({ it.run() }) {
                promise.resolve(null)
            }
        } catch (e: Exception) {
            promise.reject("PROXY_ERROR", e.message ?: "failed to clear proxy")
        }
    }

    /**
     * Whether an external app is installed (used to offer "Open in Tor Browser"). Requires the
     * target package to be declared in the manifest's <queries> block on Android 11+ (else the
     * package is invisible and this returns false even when installed).
     */
    @ReactMethod
    fun isAppInstalled(packageName: String, promise: Promise) {
        try {
            reactApplicationContext.packageManager.getPackageInfo(packageName, 0)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /**
     * Launch a URL in a specific external app via ACTION_VIEW + setPackage (empty package = let the
     * OS choose). Used for the Tor Browser hand-off. Rejects when no matching activity is found so
     * the JS layer can fall back (e.g. to the Play listing).
     */
    @ReactMethod
    fun openInApp(url: String, packageName: String, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            if (packageName.isNotEmpty()) {
                intent.setPackage(packageName)
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("NO_APP", e.message ?: "no app to handle the link")
        }
    }

    /**
     * List installed browsers (any app that can handle an https ACTION_VIEW). Used to let the user
     * pick a default external browser in Settings. The manifest <queries> declares the https VIEW
     * intent, so this is visible on Android 11+. Returns [{package, label}], deduped by package.
     */
    @ReactMethod
    fun listInstalledBrowsers(promise: Promise) {
        try {
            val pm = reactApplicationContext.packageManager
            // A web ACTION_VIEW + BROWSABLE intent — the filter every browser registers. Without the
            // BROWSABLE category some browsers (e.g. Tor Browser / Fenix) are NOT returned.
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"))
            intent.addCategory(Intent.CATEGORY_BROWSABLE)
            val resolved = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
            val seen = HashSet<String>()
            val arr = Arguments.createArray()
            for (ri in resolved) {
                val pkg = ri.activityInfo?.packageName ?: continue
                if (!seen.add(pkg)) continue
                val label = ri.loadLabel(pm)?.toString() ?: pkg
                val map = Arguments.createMap()
                map.putString("package", pkg)
                map.putString("label", label)
                arr.pushMap(map)
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("LIST_FAIL", e.message ?: "failed to list browsers")
        }
    }

    /**
     * Wipe on-device browsing data — cookies + web storage (localStorage/IndexedDB). Called at the
     * browser memory-window rollover and on a manual "new identity" reset, so a logged-in session
     * never outlives the ~1h window. Runs on the UI thread (WebStorage/CookieManager requirement).
     */
    @ReactMethod
    fun clearBrowsingData(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                val cm = CookieManager.getInstance()
                cm.removeAllCookies(null)
                cm.flush()
                WebStorage.getInstance().deleteAllData()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("CLEAR_FAIL", e.message ?: "failed to clear browsing data")
            }
        }
    }
}
