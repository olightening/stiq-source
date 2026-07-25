// StiqTorModule.kt — Android native Tor module skeleton (PLAN.md Step 4).
//
// SCAFFOLD: build inside the generated android/ project with the Tor + IPtProxy
// dependencies added. Finish the TODOs. Not compiled in CI (no Android SDK here).
//
// Satisfies the contract in client/src/tor/nativeBackend.ts:
//   - startTor(config) / stopTor()
//   - emits "StiqTorStatus" events shaped like TorBackendEvent
//
// Gradle (app/build.gradle):
//   implementation "info.guardianproject:tor-android:0.4.8.x"   // or arti-mobile
//   implementation "com.netzarchitekten:IPtProxy:4.x"           // obfs4 + snowflake

package org.stiq.client

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class StiqTorModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "StiqTor"

  private fun emit(body: WritableNativeMap) {
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("StiqTorStatus", body)
  }

  private fun status(kind: String): WritableNativeMap =
    WritableNativeMap().apply { putString("kind", kind) }

  @ReactMethod
  fun startTor(config: ReadableMap, promise: Promise) {
    emit(status("starting"))

    // val transport = config.getString("transport") ?: "webtunnel" // "webtunnel" | "obfs4" | "snowflake"
    // val bridgeLines = config.getArray("bridgeLines")
    // val socksPort = if (config.hasKey("socksPort")) config.getInt("socksPort") else 0

    // TODO:
    // 1. Start the bundled PT via IPtProxy (obfs4 or snowflake) -> local PT port.
    // 2. Assemble torrc from torrc.template: DataDirectory, SOCKSPort,
    //      ClientTransportPlugin, UseBridges 1, and Bridge <line> entries.
    // 3. Start the Tor service (tor-android) with that torrc.
    // 4. Observe bootstrap -> emit {kind:"bootstrapping", percent, summary}.
    // 5. On 100%, emit connected with the real SOCKS host/port:
    //      WritableNativeMap with kind="connected", socks={host:"127.0.0.1", port:<port>}.
    // 6. On failure emit {kind:"error", message}. NEVER open a non-Tor fallback.

    promise.resolve(null)
  }

  @ReactMethod
  fun stopTor(promise: Promise) {
    // TODO: stop the Tor service and IPtProxy.
    emit(status("stopped"))
    promise.resolve(null)
  }

  // Required for NativeEventEmitter on Android.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
