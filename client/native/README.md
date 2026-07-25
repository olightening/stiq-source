# client/native — bundled Tor module scaffolding (PLAN.md Step 4)

The TypeScript transport layer (`client/src/tor/`) is complete and tested. What remains is
the **native** Tor daemon, which must be built on a machine with the platform toolchains
(Xcode for iOS, Android SDK/NDK for Android) and a device. These files are reference
skeletons; move them into the generated `ios/` and `android/` projects during the native
build and finish the `TODO`s.

## The contract (native must satisfy `client/src/tor/nativeBackend.ts`)

Expose a native module named **`StiqTor`** that:

1. `startTor(config)` — async. `config` is `TorStartConfig`:
   `{ transport: 'obfs4'|'snowflake', bridgeLines: string[], socksPort: number, dataDir?: string }`.
   The module owns the `ClientTransportPlugin <transport> exec <bundled-binary>` torrc line
   (it knows where the bundled PT binary lives); the TS side supplies `UseBridges` + the
   `Bridge` lines (see `torrc.template`).
2. `stopTor()` — async; tears down the circuit.
3. Emits a **`StiqTorStatus`** event whose payload matches `TorBackendEvent`:
   `{kind:'starting'}`, `{kind:'bootstrapping', percent, summary?}`,
   `{kind:'connected', socks:{host,port}}`, `{kind:'error', message}`, `{kind:'stopped'}`.

The manager enforces **no clearnet fallback**: if `error`/timeout occurs the app goes
offline. Native code must therefore NEVER open a non-Tor socket as a fallback.

## Recommended libraries

| Platform | Tor daemon | Pluggable transports (obfs4 + snowflake) |
|---|---|---|
| iOS | `Tor.framework` (iCepa) via CocoaPods | `IPtProxy` (bundles obfs4proxy + snowflake) |
| Android | `tor-android` (Guardian Project) or `arti-mobile` | `IPtProxy` |

`IPtProxy` ships obfs4 and Snowflake as a single mobile-friendly library, which is why both
transports are first-class in the TS layer.

## Bundled-Tor spike (ADR 0001 — do this FIRST)

Before completing the module, run the timeboxed spike from ADR 0001 to de-risk the
framework choice:

1. Start the bundled daemon on a real iOS device AND a real Android device (no Orbot).
2. Complete a circuit through an **obfs4** bridge.
3. Open a WebSocket to a known `.onion` over that circuit.

If iOS bundling fails, reopen ADR 0001 and reconsider Flutter (Cwtch precedent).

## Files

- `ios/StiqTorModule.swift` — iOS native module skeleton (Tor.framework + IPtProxy).
- `android/StiqTorModule.kt` — Android native module skeleton (tor-android + IPtProxy).
- `torrc.template` — the torrc fragment the module assembles at runtime.

## Secrets / bridges

Real obfs4 bridge lines must be provisioned out of band (BridgeDB or private bridges) and
injected into `client/src/tor/bridges.ts` (`DEFAULT_OBFS4_BRIDGES`) or via the onboarding
payload — never commit production bridge lines that should stay unblocked.
