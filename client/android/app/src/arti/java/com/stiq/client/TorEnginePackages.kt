package com.stiq.client

import com.facebook.react.ReactPackage

/**
 * The arti flavor's Tor engine (see the `tor` flavor dimension in app/build.gradle).
 *
 * StiqArtiModule loads libarti_mobile.so lazily on the first startTor(). Registered
 * unconditionally because an absent NativeModules.StiqArti is how a build missing the native
 * library silently degrades to permanently offline (never clearnet) — createTorBackend() on the
 * JS side probes for whichever engine module the flavor linked.
 */
object TorEnginePackages {
  fun packages(): List<ReactPackage> = listOf(StiqArtiPackage())
}
