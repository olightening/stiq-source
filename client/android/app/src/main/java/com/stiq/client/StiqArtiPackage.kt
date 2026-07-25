package com.stiq.client

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers StiqArtiModule with the React Native bridge — T17 Arti-migration SPIKE.
 *
 * ⚠ DELIBERATELY NOT registered in MainApplication.kt in this spike, so the branch is fully inert
 * and isolated (no shared-file edit for another integrator to reconcile). To activate on the spike
 * build, add `add(StiqArtiPackage())` to MainApplication.getPackages() alongside
 * `add(StiqTorPackage())`. Registering it is inert anyway until USE_ARTI_BACKEND routes the TS
 * createTorBackend() to StiqArti — a non-spike build carrying this code is unaffected.
 */
class StiqArtiPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(StiqArtiModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
