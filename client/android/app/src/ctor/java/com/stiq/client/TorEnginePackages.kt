package com.stiq.client

import com.facebook.react.ReactPackage

/**
 * The ctor flavor's Tor engine (see the `tor` flavor dimension in app/build.gradle).
 *
 * StiqTorModule drives info.guardianproject:tor-android (C-tor) with pluggable transports
 * in-process via IPtProxy. Registered unconditionally — createTorBackend() on the JS side probes
 * for whichever engine module (StiqArti / StiqTor) the flavor linked and adapts at runtime; an
 * absent module degrades to permanently offline (never clearnet).
 */
object TorEnginePackages {
  fun packages(): List<ReactPackage> = listOf(StiqTorPackage())
}
