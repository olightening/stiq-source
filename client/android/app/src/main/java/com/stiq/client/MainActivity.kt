package com.stiq.client

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
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
    applyScreenGuards()
    super.onCreate(savedInstanceState)
  }

  /**
   * Window-level privacy/integrity guards, applied BEFORE super.onCreate() so they are in force for
   * the very first frame — in particular before the window is ever eligible to be captured for the
   * Recents thumbnail.
   *
   * FLAG_SECURE is applied APP-WIDE rather than per-screen, deliberately:
   *
   *  - The leak that actually happens in the field is the Recents/task-switcher thumbnail, and that
   *    is captured for the TASK, of whatever surface happened to be on top when the user
   *    backgrounded. Per-screen FLAG_SECURE therefore protects nothing unless *every* screen a user
   *    can background from is covered — and missing one is silent.
   *  - Toggling FLAG_SECURE at runtime forces the window's surface to be recreated. Doing that on
   *    navigation would put a visible flicker (and a re-layout) on ordinary screen transitions.
   *  - The set of STIQ surfaces that are NOT sensitive is close to empty: the feed, spaces, DMs,
   *    the log, settings (npub, relays, PIN), and the PIN keypad itself are all content a
   *    screenshot-scraping or screen-recording app on the same device should not get for free.
   *
   * The cost is that legitimate screenshots are blocked app-wide. That is bought back by
   * StiqScreenGuard.setSecure(false), which JS can call around a deliberate, user-initiated export
   * (e.g. saving an invite QR) and then restore — an explicit opt-out beats an implicit gap.
   *
   * setHideOverlayWindows(true) (API 31+) is the anti-tapjacking half: while our window is visible,
   * the system hides TYPE_APPLICATION_OVERLAY windows belonging to OTHER apps. That removes the
   * overlay attack surface outright, with none of the risk of touch-filtering (which can silently
   * eat legitimate taps). Below API 31 there is no equivalent, which is what
   * StiqScreenGuard.setTapjackGuard() covers on the specific surfaces that warrant it.
   */
  private fun applyScreenGuards() {
    try {
      window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    } catch (t: Throwable) {
      android.util.Log.w("MainActivity", "FLAG_SECURE could not be applied", t)
    }
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

