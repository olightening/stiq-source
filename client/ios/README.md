# Stiq iOS app

The iOS build of the Stiq client. Shares 100% of the TypeScript app code in
[`client/src`](../src) and [`App.tsx`](../App.tsx) with the Android build (React Native
0.76.5, New Architecture **off**, Hermes **on** — matching `android/gradle.properties`).

Only the **native seams** are platform-specific. This directory implements them in Swift,
mirroring the Android Kotlin modules under
[`android/app/src/main/java/com/stiq/client`](../android/app/src/main/java/com/stiq/client)
one-for-one, with byte-identical JS-facing contracts (same `NativeModules` names, same
method selectors, same emitted event shapes).

## Native modules

| Module (`NativeModules.*`) | iOS implementation | Android counterpart | JS consumer |
|---|---|---|---|
| `StiqKeystore` | Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, device-only, no iCloud) | Android Keystore AES-GCM | `src/keys/nativeKeystore.ts` |
| `StiqPow` | CommonCrypto SHA-256 NIP-13 miner (byte-exact with Kotlin) | `MessageDigest` SHA-256 | `src/dm/dm.ts` |
| `StiqSocket` | Raw POSIX socket: hand-rolled SOCKS5 CONNECT + WebSocket framing | raw `java.net.Socket` | `src/nostr/torSocket.ts` |
| `StiqWorkManager` | `BGTaskScheduler` (BGAppRefreshTask, jittered) | WorkManager periodic | `src/background/syncTask.ts` |
| `StiqTor` | `Tor.framework` + `IPtProxy` behind `#if canImport` (see below) | `tor-android` + IPtProxy | `src/tor/nativeBackend.ts` |

All five are registered automatically — Swift `@objc(Name)` classes with Objective-C
`RCT_EXTERN_MODULE` bridges (`*.m`) and a shared `stiq-Bridging-Header.h`. No manual
`RCTBridgeModule` registration list is needed on iOS (unlike Android's `MainApplication`).

## The Tor seam (`StiqTor`)

`StiqTor.swift` is guarded by `#if canImport(Tor)`:

- **With `pod 'Tor'`** (and optionally `pod 'IPtProxy'`): the full bundled-Tor daemon —
  torrc assembly, control-socket auth, bootstrap-progress events, `SIGNAL NEWNYM`. `direct`
  mode needs only `Tor`; `obfs4`/`snowflake` additionally need `IPtProxy`.
- **Without them** (the default project as committed): the module compiles and reports the
  Tor transport as *unavailable* — the JS layer surfaces a clean offline state with **no
  clearnet fallback**, exactly the device-gated seam described in
  [`docs/HANDOFF.md`](../../docs/HANDOFF.md).

To enable Tor, add to `Podfile` inside `target 'stiq'`:

```ruby
pod 'Tor', '~> 408'
pod 'IPtProxy', '~> 4'
```

then `pod install` and rebuild. (Tor.framework is a heavy GPL build; verify it on a device.)

## Build & run

```sh
cd client
npm ci --legacy-peer-deps         # react-native-get-random-values peer drift, see ../README
cd ios && pod install
cd ..

# Simulator (Release — self-contained, bundles JS):
npm run ios -- --mode Release
# or directly:
xcodebuild -workspace ios/stiq.xcworkspace -scheme stiq -configuration Release \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

For a debug build, run `npm start` (Metro) in one terminal and `npm run ios` in another.

## Configuration notes

- **Bundle id:** `com.stiq.client` (matches the Android `applicationId`).
- **Deep link:** `stiq://cred-resp?data=<b64>` — the organizer response QR. The system camera
  opens it; `RCTLinkingManager` forwards it to `App.tsx`'s `Linking` handler. Declared as the
  `stiq` URL scheme in `Info.plist`; no in-app camera library is used.
- **Background sync:** `UIBackgroundModes` = `fetch`/`processing`, task id `com.stiq.client.sync`
  registered in `AppDelegate` and listed in `BGTaskSchedulerPermittedIdentifiers`. Running the
  full headless JS sync inside the iOS background budget is a known platform gap (HANDOFF §A).
- **SQLite:** `op-sqlite` with SQLCipher (`op-sqlite.sqlcipher = true` in `package.json`).
- **ATS:** `NSAllowsLocalNetworking` only (for the `127.0.0.1` Tor SOCKS/control sockets);
  arbitrary loads stay off.
