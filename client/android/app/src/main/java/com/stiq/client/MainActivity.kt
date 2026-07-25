package com.stiq.client

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
    super.onCreate(savedInstanceState)
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
   * bundled Tor daemon ("Interrupt: exiting cleanly") and forcing a full ~2 min
   * re-bootstrap on the next launch. moveTaskToBack keeps the JS context and the Tor
   * foreground service alive, so BACK behaves like HOME and the circuit survives.
   */
  override fun invokeDefaultOnBackPressed() {
    if (!moveTaskToBack(false)) {
      super.invokeDefaultOnBackPressed()
    }
  }
}

