package com.stiq.client

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // The Tor engine is the ONE thing the two product flavors (arti / ctor) disagree
              // on: each flavor source set supplies its own TorEnginePackages returning the
              // engine it links (StiqArtiPackage or StiqTorPackage). Registered unconditionally
              // because an absent engine module is how a build missing its native library
              // silently degrades to permanently offline (never clearnet).
              addAll(TorEnginePackages.packages())
              add(StiqSocketPackage())
              add(StiqHttpPackage())
              add(StiqWebProxyPackage())
              add(StiqImagePackage())
              add(StiqKeystorePackage())
              add(StiqWorkManagerPackage())
              add(StiqUnifiedPushPackage())
              add(StiqUpdatePackage())
              add(StiqPowPackage())
              add(StiqKdfPackage())
              add(StiqSchnorrPackage())
              add(StiqRsaMathPackage())
              add(StiqAudioPackage())
              add(StiqBiometricPackage())
              add(StiqPowerPackage())
              add(StiqFilesPackage())
              add(StiqScreenGuardPackage())
              add(NoCabPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        // NOT BuildConfig.DEBUG: our debug APK embeds the JS bundle (bundleInDebug=true) and is the
        // build we field-test on real phones, where there is no Metro dev server — leaving dev
        // support on made the dev client retry localhost:8081 every 2s for the life of the process.
        // DEV_SUPPORT defaults to !bundleInDebug, so running Metro still gets the dev menu/HMR.
        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEV_SUPPORT

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
  }
}

