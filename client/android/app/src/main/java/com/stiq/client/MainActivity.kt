package com.stiq.client

import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * The manifest points this Activity at LaunchTheme (a solid #111111 windowBackground matching
   * the JS SplashScreen — see values/styles.xml) so the process-start window isn't a flash of
   * the default white background. Once the Activity is actually alive, swap back to the normal
   * AppTheme immediately before super.onCreate() runs so window inflation uses the real theme.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    applyOverlayGuard()
    super.onCreate(savedInstanceState)
  }

  /**
   * Anti-tapjacking guard, applied BEFORE super.onCreate() so it is in force for the very first
   * frame.
   *
   * setHideOverlayWindows(true) (API 31+): while our window is visible, the system hides
   * TYPE_APPLICATION_OVERLAY windows belonging to OTHER apps. That removes the overlay attack
   * surface outright, with none of the risk of touch-filtering (which can silently eat legitimate
   * taps). Below API 31 there is no equivalent.
   *
   * STIQ deliberately does NOT set FLAG_SECURE: screenshots, screen recording, and the
   * Recents/task-switcher thumbnail are all allowed, everywhere in the app. vc18 shipped an
   * app-wide FLAG_SECURE; it was removed in vc19 because blocking a user from screenshotting their
   * own community is a cost paid by every legitimate user on every screen, while an attacker who
   * can run a screen-scraper on the device has already cleared a far higher bar than the flag
   * defends. Do not reintroduce it without an explicit, per-surface reason.
   */
  private fun applyOverlayGuard() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        window.setHideOverlayWindows(true)
      } catch (t: Throwable) {
        android.util.Log.w("MainActivity", "setHideOverlayWindows failed", t)
      }
    }
  }

  /**
   * The platform resets its Android 15 `dataSync` foreground-service timer when the user brings the
   * app to the foreground, so clear our mirror of that state here. Without this, one timeout would
   * leave every background sync unpromoted for up to 24 hours even though the OS had already
   * forgiven us. See StiqFgsBudget.
   */
  override fun onResume() {
    super.onResume()
    StiqFgsBudget.clear(this)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "stiq"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Background the app on a root-level BACK press instead of finishing the Activity.
   *
   * RN calls invokeDefaultOnBackPressed() only when no JS BackHandler consumed the press.
   * The default on Android 12+ finishes the Activity, which unmounts React and runs
   * App.tsx's cleanup — that calls manager.disconnect() -> stopTor(), shutting down the
   * embedded Arti Tor client and forcing a full re-bootstrap on the next launch.
   * moveTaskToBack keeps the JS context (and Arti, which runs in-process rather than as a
   * separate foreground service) alive, so BACK behaves like HOME and the circuit survives.
   */
  override fun invokeDefaultOnBackPressed() {
    if (!moveTaskToBack(false)) {
      super.invokeDefaultOnBackPressed()
    }
  }
}

