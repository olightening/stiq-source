package com.stiq.client

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers StiqArtiModule with the React Native bridge.
 *
 * `createTorBackend()` always routes to StiqArti now (Arti is the sole Tor engine — C-tor/
 * StiqTorModule/StiqTorPackage have been removed), and StiqArtiModule loads `libarti_mobile.so`
 * lazily on the first startTor(). So registering this package alone pays for a module
 * instantiation and nothing else — no native library load, no threads, no Tor.
 *
 * It has to be registered, because `NativeModules.StiqArti` being undefined is exactly how the
 * app degrades to UnavailableTorBackend and goes offline (never clearnet). Omitting this line
 * produces an app that is silently, permanently disconnected.
 */
class StiqArtiPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(StiqArtiModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
