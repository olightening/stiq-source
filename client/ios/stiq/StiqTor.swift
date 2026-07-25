//
//  StiqTor.swift — bundled Tor daemon + obfs4/webtunnel/snowflake pluggable transports.
//  iOS counterpart of android/.../StiqTorModule.kt. Implemented from the JS contract
//  (client/src/tor/nativeBackend.ts + types.ts), NOT the old scaffold.
//
//  JS contract:
//      startTor({transport, bridgeLines, socksPort, dataDir, onionAuth, onionAuthExtra, dormancy})
//                                                             -> Promise<void>   (resolves on connect)
//      stopTor()            -> Promise<void>
//      newCircuit()         -> Promise<void>   (App.tsx — SIGNAL NEWNYM)
//      setDormant()         -> Promise<void>   (dormancy.ts — SIGNAL DORMANT)
//      setActive()          -> Promise<void>   (dormancy.ts — SIGNAL ACTIVE)
//      getHttpTunnelPort()  -> Promise<number> (mediaService.ts — 0 when unknown)
//      getNetworkClass()    -> Promise<string> (nativeBackend.ts — coarse transport class)
//  Emits "StiqTorStatus" shaped like TorBackendEvent:
//      {kind:"starting"} / {kind:"bootstrapping",percent,summary} /
//      {kind:"connected",socks:{host,port},torVersion?} / {kind:"error",message} / {kind:"stopped"}
//  Emits "StiqTorNetworkChange" {networkClass, isExpensive, isConstrained} when the default network
//  SWITCHES (Android parity: StiqTorModule.registerNetworkMonitor) so App.tsx can bounce the relay
//  ahead of the ~90s watchdog. iOS's payload is a SUPERSET of Android's: it adds the NWPath cost
//  hints (isExpensive/isConstrained booleans); Android emits {networkClass} alone. JS listeners
//  ignore unknown fields, so the extra keys are purely additive.
//
//  THE ONE-START INVARIANT (see the port plan's Ruling). A second TorThread in one process re-enters
//  tor_run_main over tor's shared C globals → SIGABRT. So tor starts AT MOST ONCE per process
//  lifetime. stopTor() does NOT cancel the thread (it only tells JS we are offline and leaves the
//  daemon warm for a fast reconnect); a later startTor() RECONFIGURES the live daemon over the
//  control port (SETCONF transport/bridges + DisableNetwork toggle) instead of spawning a new thread.
//
//  There is NO clearnet fallback: on any failure we emit {kind:"error"} and the JS layer goes offline.
//
//  Control is over a control PORT (autoControlPort → ControlPort auto + ControlPortWriteToFile), NOT a
//  unix socket: an app-container control-socket path exceeds the 104-char sun_path limit and tor fails
//  to bind it. The port file is a regular file, unaffected by that limit.
//

import Foundation
import Network
import os
import UIKit

#if canImport(Tor)
import Tor
#endif
#if canImport(IPtProxy)
import IPtProxy
#endif

#if canImport(Tor)

@objc(StiqTor)
class StiqTor: RCTEventEmitter {

  private var hasListeners = false
  static let logHandle = OSLog(subsystem: "com.stiq.client", category: "StiqTor")

  // One-start state (guarded by `lifecycleLock`).
  private let lifecycleLock = NSLock()
  private var torThread: TorThread?
  private var torController: TorController?
  private var torDataDir: URL?
  private var started = false
  private var lastSocksPort = 0
  private var lastHttpTunnelPort = 0
  private var lastTorVersion: String?

  // The current start's one-shot resolve (cleared after the first connect/error).
  private var startResolve: RCTPromiseResolveBlock?
  private var resolved = false

  #if canImport(IPtProxy)
  // IPtProxy permits ONE Controller per process; create lazily, reuse for the process lifetime.
  private static var ptController: IPtProxyController?
  #endif

  // Persistent default-network monitor (Android parity: registerNetworkMonitor / the
  // StiqTorNetworkChange nudge). Armed once alongside the one-start daemon, never torn down —
  // process-lifetime, like the daemon itself. `lastNetSignature` is only touched on
  // `netMonitorQueue`, so it needs no lock.
  private var netMonitor: NWPathMonitor?
  private let netMonitorQueue = DispatchQueue(label: "stiq.tor.netmonitor")
  private var lastNetSignature: String?
  private var sawPathLoss = false

  // Latest classification + path attributes cached by the persistent monitor for every update, so
  // getNetworkClass() reads the live value instead of spinning up a throwaway one-shot monitor
  // (change #2). Guarded by `netStateLock`; `netStateFresh` flips true on the first delivered update.
  private let netStateLock = NSLock()
  private var lastNetworkClass = "unknown"
  private var lastPathExpensive = false
  private var lastPathConstrained = false
  private var netStateFresh = false

  // Background quiesce assertion (change #1). iOS suspends the process seconds after backgrounding,
  // which freezes the JS 30s grace timer that would enter Tor dormancy (SIGNAL DORMANT + relay
  // close). A UIBackgroundTask assertion buys ~30s of wall-clock so that designed quiesce actually
  // runs; the JS side independently handles the OS granting less. Guarded by `bgTaskLock`.
  private let bgTaskLock = NSLock()
  private var bgQuiesceTask: UIBackgroundTaskIdentifier = .invalid
  private var quiesceObserversRegistered = false

  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! { ["StiqTorStatus", "StiqTorNetworkChange"] }
  override func startObserving() { hasListeners = true; os_log("startObserving (JS subscribed)", log: Self.logHandle, type: .info) }
  override func stopObserving() { hasListeners = false }

  private func emit(_ body: [String: Any]) {
    let kind = (body["kind"] as? String) ?? "?"
    let extra = (body["message"] as? String) ?? (body["percent"].map { "\($0)" } ?? "")
    os_log("emit %{public}@ %{public}@ (hasListeners=%{public}d)", log: Self.logHandle, type: .info, kind, extra, hasListeners ? 1 : 0)
    if hasListeners { sendEvent(withName: "StiqTorStatus", body: body) }
  }

  // ── React methods ──────────────────────────────────────────────────────────────────────────

  @objc(startTor:resolver:rejecter:)
  func startTor(_ config: NSDictionary,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    emit(["kind": "starting"])

    let transport = (config["transport"] as? String) ?? "direct"
    let bridgeLines = (config["bridgeLines"] as? [String]) ?? []
    let socksPortReq = (config["socksPort"] as? NSNumber)?.intValue ?? 0

    lifecycleLock.lock()
    let alreadyStarted = started
    lifecycleLock.unlock()
    os_log("startTor transport=%{public}@ bridges=%{public}d alreadyStarted=%{public}d",
           log: Self.logHandle, type: .info, transport, bridgeLines.count, alreadyStarted ? 1 : 0)

    DispatchQueue.global(qos: .userInitiated).async {
      if alreadyStarted {
        // ONE-START re-entry: reconfigure the LIVE daemon; never spawn a second thread.
        self.reconfigureLive(config: config, transport: transport, bridgeLines: bridgeLines,
                             resolve: resolve, reject: reject)
        return
      }
      self.firstStart(config: config, transport: transport, bridgeLines: bridgeLines,
                      socksPortReq: socksPortReq, resolve: resolve, reject: reject)
    }
  }

  @objc(stopTor:rejecter:)
  func stopTor(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    // ONE-START: do NOT cancel the thread (that re-enters tor_run_main on the next start → SIGABRT).
    // Take the daemon offline at the network layer and tell JS we stopped; the warm daemon stays
    // ready for a fast reconnect. DisableNetwork is idempotent and reversible via the next startTor.
    lifecycleLock.lock()
    let controller = torController
    lifecycleLock.unlock()
    if let c = controller {
      _ = self.controlSync(c, "SETCONF", ["DisableNetwork=1"], timeout: 5)
    }
    emit(["kind": "stopped"])
    resolve(nil)
  }

  @objc(newCircuit:rejecter:)
  func newCircuit(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    signal("NEWNYM"); resolve(nil)
  }

  @objc(setDormant:rejecter:)
  func setDormant(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Under one-start, SIGNAL DORMANT/ACTIVE is the ONLY lifecycle lever (see the plan). Best-effort,
    // fire-and-forget: a live daemon that never consumes the signal simply stays warm.
    signal("DORMANT"); resolve(nil)
  }

  @objc(setActive:rejecter:)
  func setActive(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    signal("ACTIVE"); resolve(nil)
  }

  @objc(getHttpTunnelPort:rejecter:)
  func getHttpTunnelPort(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    lifecycleLock.lock()
    let controller = torController
    var port = lastHttpTunnelPort
    lifecycleLock.unlock()
    if port == 0, let c = controller {
      port = parsePort(controlSync(c, "GETINFO", ["net/listeners/httptunnel"], timeout: 5).1)
      if port > 0 { lifecycleLock.lock(); lastHttpTunnelPort = port; lifecycleLock.unlock() }
    }
    resolve(port)
  }

  @objc(getNetworkClass:rejecter:)
  func getNetworkClass(_ resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Best-effort coarse class. Served from the persistent monitor's cached value once it has
    // delivered at least one update (change #2 — no more per-call one-shot NWPathMonitor); falls
    // back to a bounded one-shot probe only before the persistent monitor is armed. Normalized
    // JS-side (nativeBackend.ts) — any value it doesn't recognize becomes 'unknown', so harmless.
    resolve(currentNetworkClass())
  }

  // ── First (and only) start ───────────────────────────────────────────────────────────────────

  private func firstStart(config: NSDictionary, transport: String, bridgeLines: [String],
                          socksPortReq: Int,
                          resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    // Arm the default-network monitor alongside the (one) daemon start. Idempotent — the guard
    // inside keeps a retried/aborted first start from doubling it.
    startNetworkMonitor()
    // Arm the background quiesce assertion observers (change #1). Idempotent; only registered on
    // a real (first) start so the assertion is never taken before Tor exists to quiesce.
    registerQuiesceObservers()
    do {
      // App-private state directory (tor refuses group/other-accessible dirs).
      let dataDir: URL
      if let dir = config["dataDir"] as? String, !dir.isEmpty {
        dataDir = URL(fileURLWithPath: dir, isDirectory: true)
      } else {
        let support = try FileManager.default.url(
          for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        dataDir = support.appendingPathComponent("tor", isDirectory: true)
      }
      try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true,
                                              attributes: [.posixPermissions: 0o700])

      // Keep the tor state out of iCloud backups (change #4a). The DataDirectory holds guard state
      // and the control_auth_cookie; under the censorship-resistance threat model neither must ever
      // reach an off-device backup. Directory-level exclusion covers files tor creates later. The
      // keychain side is already WhenUnlockedThisDeviceOnly, so this closes the last backup leak.
      // Best-effort: try? + log on failure, never fatal (a missing exclusion is not worth aborting
      // the whole daemon start over).
      do {
        var excludedDir = dataDir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excludedDir.setResourceValues(values)
      } catch {
        os_log("backup-exclude: dataDir failed: %{public}@", log: Self.logHandle, type: .error,
               error.localizedDescription)
      }

      // v3 onion client authorization (lever 2): materialize <host>.auth_private into a private
      // ClientOnionAuthDir BEFORE boot, so tor can resolve the members-only relay's auth-gated
      // descriptor. Mirrors StiqTorModule.kt's onion_auth handling and the "<host>:descriptor:x25519:
      // <key>" line format. The JS layer (src/tor/onionAuth.ts) has already validated host + key shape.
      let onionAuthDir = dataDir.appendingPathComponent("onion_auth", isDirectory: true)
      var wroteAnyOnionAuth = false
      func writeOnionAuth(_ host: String, _ key: String) throws {
        try FileManager.default.createDirectory(at: onionAuthDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let file = onionAuthDir.appendingPathComponent("\(host).auth_private")
        try "\(host):descriptor:x25519:\(key)\n".write(to: file, atomically: true, encoding: .utf8)
        wroteAnyOnionAuth = true
      }
      if let auth = config["onionAuth"] as? NSDictionary,
         let host = auth["onionHost"] as? String, let key = auth["privKeyBase32"] as? String {
        try writeOnionAuth(host, key)
      }
      if let extra = config["onionAuthExtra"] as? [NSDictionary] {
        for e in extra {
          if let host = e["onionHost"] as? String, let key = e["privKeyBase32"] as? String {
            try writeOnionAuth(host, key)
          }
        }
      }

      // Pluggable transport (obfs4/webtunnel/snowflake). Direct needs none. Unlike Android we do NOT
      // warm an obfs4 PT for direct mode (that Android hack exists for a different reason; lever c).
      var ptPort: Int? = nil
      if transport != "direct" {
        guard !bridgeLines.isEmpty else {
          throw NSError(domain: "StiqTor", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "bridgeLines required for \(transport)"])
        }
        ptPort = try Self.startPluggableTransport(transport, stateDir: dataDir)
      }

      let configuration = TorConfiguration()
      configuration.cookieAuthentication = true
      configuration.autoControlPort = true          // ControlPort auto + ControlPortWriteToFile (port file)
      configuration.ignoreMissingTorrc = true
      configuration.avoidDiskWrites = false         // P0 lever (a): warm-cache restart beats Android cold start
      configuration.clientOnly = true               // pure client — never a relay/dir mirror
      configuration.dataDirectory = dataDir
      if wroteAnyOnionAuth { configuration.clientAuthDirectory = onionAuthDir } // ClientOnionAuthDir

      var options: [String: String] = [
        // 'auto' + IsolateSOCKSAuth: each SOCKS credential (per-socket circuit isolation) gets its own
        // circuit — the anonymity invariant StiqSocket depends on. ExtendedErrors surfaces onion dial
        // causes (0xF0-0xF7) the JS layer distinguishes. Pinned, not left to defaults.
        "SOCKSPort": "auto IsolateSOCKSAuth ExtendedErrors",
        "SafeSocks": "1",
        "HTTPTunnelPort": "auto",       // media path (mediaService.ts:getHttpTunnelPort) — was missing before
        "ClientUseIPv6": "1",           // many mobile carriers are IPv6-only (NAT64/464XLAT)
        "ConfluxEnabled": "0",
        "SafeLogging": "1",
        // KEEP (genuine T1 wins under one-start): don't churn the live onion circuit; keep a clean one warm.
        "MaxCircuitDirtiness": "3600",
        "CircuitsAvailableTimeout": "3600",
        // KEEP, load-bearing under one-start: DORMANT/ACTIVE is the only lifecycle lever, and the
        // held-open relay socket must count as activity so a foreground-idle session never auto-dormants.
        "DormantTimeoutDisabledByIdleStreams": "1",
        "DormantCanceledByStartup": "1",
        "Log": "notice stderr",
      ]
      // DROPPED vs Android (Path A suspends; keepalive can't fire when it would matter, padding only
      // burns battery + adds a foreground fingerprint): KeepalivePeriod, ConnectionPadding,
      // ReducedConnectionPadding, AvoidDiskWrites, __OwningControllerProcess (single process — no
      // dead-man's switch needed).

      var args: [String] = []
      if transport != "direct", let pt = ptPort {
        options["UseBridges"] = "1"
        args += ["--ClientTransportPlugin", "\(transport) socks5 127.0.0.1:\(pt)"]
        for line in bridgeLines { args += ["--Bridge", line] }
      } else {
        options["UseBridges"] = "0"
      }
      configuration.options = NSMutableDictionary(dictionary: options)
      if !args.isEmpty { configuration.arguments = NSMutableArray(array: args) }

      guard let portFile = configuration.controlPortFile else {
        throw NSError(domain: "StiqTor", code: 5,
                      userInfo: [NSLocalizedDescriptionKey: "no controlPortFile from configuration"])
      }
      // CRITICAL: the control-port file PERSISTS in the DataDirectory across launches. A stale file
      // names the PREVIOUS (dead) daemon's port, so a fresh launch that reads it before tor rewrites
      // it connects to a dead port → "Connection refused" → direct Tor wrongly fails and the cascade
      // needlessly escalates to bridges. Delete it (and the cookie) BEFORE start so the wait below
      // blocks until THIS daemon writes fresh ones.
      try? FileManager.default.removeItem(at: portFile)
      try? FileManager.default.removeItem(at: dataDir.appendingPathComponent("control_auth_cookie"))

      let thread = TorThread(configuration: configuration)
      lifecycleLock.lock()
      torThread = thread
      torDataDir = dataDir
      started = true
      startResolve = resolve
      resolved = false
      lifecycleLock.unlock()
      thread.start()

      // Wait for THIS daemon's control port file to contain a PARSEABLE port (not just exist — tor
      // creates the file, then writes to it; reading it empty yields a bad port) AND its cookie.
      // Parse the port ourselves and use the host/port initializer, exactly like a raw control client
      // — TorController(controlPortFile:) reads the file once at init and can race tor's write.
      let deadline = Date().addingTimeInterval(15)
      let cookieFile = dataDir.appendingPathComponent("control_auth_cookie")
      var controlPort: UInt16 = 0
      while controlPort == 0 {
        if Date() > deadline {
          throw NSError(domain: "StiqTor", code: 6,
                        userInfo: [NSLocalizedDescriptionKey: "tor control port file never appeared"])
        }
        if FileManager.default.fileExists(atPath: cookieFile.path),
           let contents = try? String(contentsOf: portFile, encoding: .utf8),
           let m = contents.range(of: #"PORT=127\.0\.0\.1:(\d+)"#, options: .regularExpression) {
          let portStr = contents[m].replacingOccurrences(of: "PORT=127.0.0.1:", with: "")
          if let p = UInt16(portStr) { controlPort = p; break }
        }
        Thread.sleep(forTimeInterval: 0.05)
      }
      os_log("control port ready: %{public}d", log: Self.logHandle, type: .info, Int(controlPort))

      let controller = try connectAndAuthWithRetry(port: controlPort, dataDir: dataDir)
      lifecycleLock.lock()
      torController = controller
      lifecycleLock.unlock()
      // Belt-and-suspenders alongside the boot-time file/ClientOnionAuthDir path above: a
      // post-enrollment COLD launch carries onionAuth in config, so register it at runtime too
      // (keeps parity with the reconfigureLive enrollment path; the file write above is retained).
      registerOnionAuth(controller, config)
      observeBootstrap(controller)
    } catch {
      emit(["kind": "error", "message": error.localizedDescription])
      lifecycleLock.lock()
      let r = startResolve; startResolve = nil
      lifecycleLock.unlock()
      r?(nil)
    }
  }

  // ── Live reconfigure (one-start re-entry: transport switch without a new thread) ─────────────

  private func reconfigureLive(config: NSDictionary, transport: String, bridgeLines: [String],
                               resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    lifecycleLock.lock()
    let controller = torController
    startResolve = resolve
    resolved = false
    lifecycleLock.unlock()
    guard let c = controller else {
      // Started flag set but no controller (mid-first-start). Just resolve; the first start drives events.
      resolve(nil); return
    }

    // CRITICAL enrollment path: the members-only relay needs v3 onion client-auth, and enrollment
    // arrives here (JS disconnect()+re-startTor with config.onionAuth set). The boot-time file path
    // never re-runs under one-start, so register the auth LIVE over the control port before we toggle
    // the network — otherwise the auth-gated relay stays unreachable and enrollment fails.
    registerOnionAuth(c, config)

    _ = controlSync(c, "SIGNAL", ["ACTIVE"], timeout: 5)

    if transport == "direct" {
      _ = controlSync(c, "RESETCONF", ["UseBridges", "ClientTransportPlugin", "Bridge"], timeout: 5)
    } else {
      do {
        let pt = try Self.startPluggableTransport(transport, stateDir: currentDataDir())
        var setArgs = ["UseBridges=1", "ClientTransportPlugin=\(transport) socks5 127.0.0.1:\(pt)"]
        for line in bridgeLines { setArgs.append("Bridge=\(line)") }
        _ = controlSync(c, "SETCONF", setArgs, timeout: 8)
      } catch {
        emit(["kind": "error", "message": error.localizedDescription])
        resolve(nil); return
      }
    }
    // Force a clean re-bootstrap through the new transport (a plain SETCONF leaves tor on stale
    // direct dir-info — see the in-process-restart gotcha).
    _ = controlSync(c, "SETCONF", ["DisableNetwork=1"], timeout: 5)
    _ = controlSync(c, "SETCONF", ["DisableNetwork=0"], timeout: 5)
    // Re-arm bootstrap tracking; startBootstrapPoll (inside observeBootstrap) re-resolves 'connected'
    // at 100% by polling — it handles the "already bootstrapped, no replayed event" case itself.
    observeBootstrap(c)
  }

  // ── Control connection / bootstrap ───────────────────────────────────────────────────────────

  /// Connect + cookie-authenticate a control connection, returning a WORKING controller.
  ///
  /// iCepa's `TorController(socketHost:port:)` CONNECTS INSIDE its initializer (`[self connect:nil]`).
  /// So we must NOT call `connect()` again — a second call hits `if (_channel) return NO` and throws a
  /// bogus generic error, discarding a perfectly good connection. Instead: construct, check
  /// `isConnected`, and if the port wasn't listening yet (tor writes the port file a few seconds
  /// before it binds), discard and retry with a FRESH controller (the init already spent this one's
  /// single connect attempt). Bounded (~20s) so a genuinely dead daemon still fails.
  private func connectAndAuthWithRetry(port: UInt16, dataDir: URL) throws -> TorController {
    let cookiePath = dataDir.appendingPathComponent("control_auth_cookie")
    var lastError: Error?
    for attempt in 0..<100 {
      let controller = TorController(socketHost: "127.0.0.1", port: port)  // connects in init
      if controller.isConnected {
        do {
          let cookie = try Data(contentsOf: cookiePath)
          let sem = DispatchSemaphore(value: 0)
          var authError: Error?
          // Explicit `completion:` label — a bare trailing closure is ambiguous vs the async overload.
          controller.authenticate(with: cookie, completion: { success, error in
            if !success {
              authError = error ?? NSError(domain: "StiqTor", code: 2,
                                           userInfo: [NSLocalizedDescriptionKey: "control auth failed"])
            }
            sem.signal()
          })
          _ = sem.wait(timeout: .now() + 10)
          if let e = authError { throw e }
          if attempt > 0 { os_log("control connected after %{public}d retries", log: Self.logHandle, type: .info, attempt) }
          return controller
        } catch {
          lastError = error
          controller.disconnect()
        }
      } else {
        lastError = NSError(domain: "StiqTor", code: 7,
                            userInfo: [NSLocalizedDescriptionKey: "control port not yet listening"])
      }
      Thread.sleep(forTimeInterval: 0.2)
    }
    throw lastError ?? NSError(domain: "StiqTor", code: 7,
                              userInfo: [NSLocalizedDescriptionKey: "control connect failed"])
  }

  private func observeBootstrap(_ controller: TorController) {
    // Fast path: async STATUS_CLIENT events, when iCepa delivers them. SETEVENTS is required —
    // addObserverForStatusEvents is a passive observer; listen(forEvents:) sends the subscription.
    // CRITICAL: never issue a control command from inside this observer block. It runs on iCepa's
    // control-read queue; a synchronous GETINFO here blocks that queue on a reply the same queue must
    // read → deadlock. So at 100% we hop OFF this thread before resolving.
    controller.listen(forEvents: ["STATUS_CLIENT"], completion: { _, _ in })
    controller.addObserver(forStatusEvents: {
      [weak self] (type, _, action, arguments) -> Bool in
      guard let self = self else { return true }
      guard type == "STATUS_CLIENT", action == "BOOTSTRAP" else { return true }
      let pct = Int(arguments?["PROGRESS"] ?? "0") ?? 0
      let summary = arguments?["SUMMARY"] ?? "Connecting"
      if pct >= 100 {
        DispatchQueue.global(qos: .userInitiated).async { self.resolveConnectedOnce(controller) }
      } else if pct > 0 {
        self.emit(["kind": "bootstrapping", "percent": pct, "summary": summary])
      }
      return true
    })
    // Robust path (the authority): poll bootstrap-phase on a background queue until connected. Does
    // NOT depend on async event delivery — iCepa's observer can stay silent, and tor never replays a
    // past 100%, so a single probe that lands early would miss the completion that arrives later.
    startBootstrapPoll(controller)
  }

  private func startBootstrapPoll(_ controller: TorController) {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self = self else { return }
      os_log("bootstrap poll: started", log: Self.logHandle, type: .info)
      let deadline = Date().addingTimeInterval(240)
      var lastEmitted = -1
      while Date() < deadline {
        self.lifecycleLock.lock(); let done = self.resolved; self.lifecycleLock.unlock()
        if done { return }
        let (ok, lines) = self.controlSync(controller, "GETINFO", ["status/bootstrap-phase"], timeout: 5)
        let joined = lines.joined(separator: " ")
        os_log("bootstrap poll: ok=%{public}d reply=%{public}@", log: Self.logHandle, type: .info, ok ? 1 : 0, joined)
        if let r = joined.range(of: #"PROGRESS=(\d+)"#, options: .regularExpression) {
          let pct = Int(joined[r].dropFirst("PROGRESS=".count)) ?? 0
          if pct >= 100 {
            os_log("bootstrap poll: 100%% → resolving connected", log: Self.logHandle, type: .info)
            self.resolveConnectedOnce(controller)
            return
          } else if pct > 0 && pct != lastEmitted {
            lastEmitted = pct
            var summary = "Connecting"
            if let sr = joined.range(of: #"SUMMARY="[^"]*""#, options: .regularExpression) {
              summary = String(joined[sr]).replacingOccurrences(of: "SUMMARY=", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            }
            self.emit(["kind": "bootstrapping", "percent": pct, "summary": summary])
          }
        }
        Thread.sleep(forTimeInterval: 1.0)
      }
      os_log("bootstrap poll: deadline reached without 100%% (JS-side timeout handles this)",
             log: Self.logHandle, type: .error)
    }
  }

  private func resolveConnectedOnce(_ controller: TorController) {
    lifecycleLock.lock()
    if resolved { lifecycleLock.unlock(); return }
    resolved = true
    lifecycleLock.unlock()

    // Learn the daemon version (warn-only >=0.4.8 guard JS-side) — best-effort.
    let ver = controlSync(controller, "GETINFO", ["version"], timeout: 5).1.joined()
    if let r = ver.range(of: #"[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?"#, options: .regularExpression) {
      lastTorVersion = String(ver[r])
    }
    let socksPort = parsePort(controlSync(controller, "GETINFO", ["net/listeners/socks"], timeout: 5).1)
    let httpPort = parsePort(controlSync(controller, "GETINFO", ["net/listeners/httptunnel"], timeout: 5).1)
    lifecycleLock.lock()
    if socksPort > 0 { lastSocksPort = socksPort }
    if httpPort > 0 { lastHttpTunnelPort = httpPort }
    let port = lastSocksPort
    let version = lastTorVersion
    let dataDir = torDataDir
    let r = startResolve; startResolve = nil
    lifecycleLock.unlock()

    // Tighten data protection on the control cookie now that the daemon is up (change #4b). Apply
    // FileProtectionType.complete: the file is unreadable while the device is locked. This is safe
    // under the one-start invariant — tor writes the cookie exactly once per process (at boot,
    // before this point), and the only readers are NEW control connections, which we open only from
    // the unlocked foreground (startTor/getHttpTunnelPort, all foreground-driven). Best-effort:
    // try? + log on failure, never fatal.
    if let dir = dataDir {
      let cookie = dir.appendingPathComponent("control_auth_cookie")
      do {
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.complete], ofItemAtPath: cookie.path)
      } catch {
        os_log("cookie-protect: setAttributes failed: %{public}@", log: Self.logHandle,
               type: .error, error.localizedDescription)
      }
    }

    var body: [String: Any] = ["kind": "connected", "socks": ["host": "127.0.0.1", "port": port]]
    if let v = version { body["torVersion"] = v }
    emit(body)
    r?(nil)
  }

  // ── Control helpers ──────────────────────────────────────────────────────────────────────────

  /// Send one control command and block (bounded) for its reply. Returns (allLinesWere250, lines).
  @discardableResult
  private func controlSync(_ controller: TorController, _ command: String, _ args: [String],
                           timeout: TimeInterval) -> (Bool, [String]) {
    let sem = DispatchSemaphore(value: 0)
    var ok = true
    var out: [String] = []
    controller.sendCommand(command, arguments: args, data: nil) { codes, lines, stop in
      for code in codes where code.intValue != 250 { ok = false }
      for line in lines { out.append(String(decoding: line, as: UTF8.self)) }
      stop.pointee = true
      sem.signal()
      return true
    }
    if sem.wait(timeout: .now() + timeout) == .timedOut { return (false, out) }
    return (ok, out)
  }

  /// v3 onion client-auth at RUNTIME (one-start-safe). The file/ClientOnionAuthDir path in firstStart
  /// only takes effect at boot; reconfigureLive never re-boots, so the enrollment cascade
  /// (JS disconnect()+re-startTor with onionAuth set) would leave the auth-gated relay unreachable.
  /// `ONION_CLIENT_AUTH_ADD <host> x25519:<b64>` registers it live (tor >=0.4.3; bundled 0.4.9.x).
  /// The join code carries the x25519 private key as UNPADDED UPPERCASE BASE32 (52 chars) but the
  /// control command wants the raw 32 bytes BASE64-encoded — so we base32-decode → base64 here.
  /// `<host>` is the bare 56-char onion host WITHOUT `.onion`. Best-effort, idempotent, never throws.
  private func registerOnionAuth(_ controller: TorController, _ config: NSDictionary) {
    func addOne(_ host: String, _ keyBase32: String) {
      guard !host.isEmpty, let b64 = Self.base32DecodeToBase64(keyBase32) else {
        os_log("onion-auth: skipping %{public}@ (bad host/key)", log: Self.logHandle, type: .error, host)
        return
      }
      let (ok, lines) = controlSync(controller, "ONION_CLIENT_AUTH_ADD",
                                    [host, "x25519:\(b64)"], timeout: 8)
      let reply = lines.joined(separator: " ")
      // A non-250 that says the credential is already present ("already") or was superseded
      // ("Client for onion existed and replaced", 251/252-style) is success — the credential IS
      // registered either way (idempotent re-entry; observed live on the 2026-07-18 sim run).
      if ok || reply.range(of: "already", options: .caseInsensitive) != nil
            || reply.range(of: "existed", options: .caseInsensitive) != nil {
        os_log("onion-auth: registered %{public}@", log: Self.logHandle, type: .info, host)
      } else {
        os_log("onion-auth: failed %{public}@ reply=%{public}@", log: Self.logHandle, type: .error, host, reply)
      }
    }
    if let auth = config["onionAuth"] as? NSDictionary,
       let host = auth["onionHost"] as? String, let key = auth["privKeyBase32"] as? String {
      addOne(host, key)
    }
    if let extra = config["onionAuthExtra"] as? [NSDictionary] {
      for e in extra {
        if let host = e["onionHost"] as? String, let key = e["privKeyBase32"] as? String {
          addOne(host, key)
        }
      }
    }
  }

  /// RFC4648 base32-decode an UNPADDED UPPERCASE base32 string (A-Z2-7) to raw bytes, returned as a
  /// base64 string. Pads to a multiple of 8 with '=' first. Returns nil on any invalid character.
  private static func base32DecodeToBase64(_ s: String) -> String? {
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    var map = [Character: UInt8]()
    for (i, c) in alphabet.enumerated() { map[c] = UInt8(i) }
    // Pad the input to a multiple of 8 characters with '=' (RFC4648 block size).
    var padded = s
    let rem = padded.count % 8
    if rem != 0 { padded += String(repeating: "=", count: 8 - rem) }

    var out = [UInt8]()
    var buffer: UInt32 = 0
    var bitsLeft = 0
    for c in padded {
      if c == "=" { break }                 // padding — trailing, nothing follows
      guard let v = map[c] else { return nil }  // invalid character
      buffer = (buffer << 5) | UInt32(v)
      bitsLeft += 5
      if bitsLeft >= 8 {
        bitsLeft -= 8
        out.append(UInt8((buffer >> UInt32(bitsLeft)) & 0xFF))
      }
    }
    return Data(out).base64EncodedString()
  }

  /// Fire a SIGNAL over the live control connection. Best-effort, never throws.
  private func signal(_ name: String) {
    lifecycleLock.lock()
    let c = torController
    lifecycleLock.unlock()
    guard let controller = c else { return }
    _ = controlSync(controller, "SIGNAL", [name], timeout: 5)
  }

  private func parsePort(_ lines: [String]) -> Int {
    for line in lines {
      if let m = line.range(of: #":(\d+)"#, options: .regularExpression) {
        let digits = line[m].dropFirst()
        if let p = Int(digits) { return p }
      }
    }
    return 0
  }

  private func currentDataDir() -> URL {
    lifecycleLock.lock()
    let dir = torDataDir
    lifecycleLock.unlock()
    if let d = dir { return d }
    let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true))
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return support.appendingPathComponent("tor", isDirectory: true)
  }

  /// Coarse transport class of an NWPath — the value set shared with Android's
  /// currentNetworkClass() and normalized JS-side (nativeBackend.ts NetworkClass).
  private static func classify(_ path: NWPath) -> String {
    if path.usesInterfaceType(.wifi) { return "wifi" }
    if path.usesInterfaceType(.cellular) { return "cellular" }
    if path.usesInterfaceType(.wiredEthernet) { return "ethernet" }
    return path.status == .satisfied ? "other" : "unknown"
  }

  /// Coarse network class for the exported getNetworkClass bridge (Android parity: wifi|cellular|
  /// ethernet|other|unknown). Prefers the value the PERSISTENT monitor has cached (change #2) so we
  /// no longer spin up a throwaway one-shot NWPathMonitor + semaphore on the hot path. The one-shot
  /// probe survives ONLY as a fallback for the case where the persistent monitor has never delivered
  /// an update yet — e.g. JS calls getNetworkClass before startTor arms the monitor. Always resolves
  /// a String; the signature is unchanged.
  private func currentNetworkClass() -> String {
    netStateLock.lock()
    let fresh = netStateFresh
    let cached = lastNetworkClass
    netStateLock.unlock()
    if fresh { return cached }

    // Fallback: persistent monitor not armed / no update yet. One-shot probe, bounded to 2s.
    let monitor = NWPathMonitor()
    let sem = DispatchSemaphore(value: 0)
    var result = "unknown"
    monitor.pathUpdateHandler = { path in
      result = Self.classify(path)
      sem.signal()
    }
    let q = DispatchQueue(label: "stiq.tor.netclass")
    monitor.start(queue: q)
    _ = sem.wait(timeout: .now() + 2)
    monitor.cancel()
    return result
  }

  // ── Default-network monitor ──────────────────────────────────────────────────────────────────

  /// Watch the device's default network and nudge JS when it SWITCHES (Wi-Fi↔cellular, roaming).
  /// On a switch the live Tor circuits + relay socket are dead, but a blocking read won't notice
  /// for up to the ~90s relay watchdog — the nudge lets App.tsx's StiqTorNetworkChange listener
  /// bounce the relay within seconds. Mirrors StiqTorModule.kt's ConnectivityManager
  /// default-network callback semantics: the first SATISFIED path is the baseline (no emit), and
  /// only a genuine identity change of a usable path emits — never a plain loss (bouncing the
  /// relay onto a dead network would misfire the escalation chain; losses stay watchdog-recovered,
  /// as on Android). Best-effort: a missed nudge falls back to the watchdog, and a spurious one is
  /// ignored JS-side unless the relay is actually live.
  ///
  /// SIMULATOR NOTE (verified 2026-07-18): toggling the HOST Mac's Wi-Fi delivers the baseline and
  /// the `unsatisfied` loss update in the sim, but the sim's network stack often never delivers
  /// the REGAIN update (Apple's guidance: restart the simulator after changing Mac network
  /// config) — so the loss→regain emit can only be end-to-end-verified on a real device.
  private func startNetworkMonitor() {
    guard netMonitor == nil else { return }
    let monitor = NWPathMonitor()
    netMonitor = monitor
    monitor.pathUpdateHandler = { [weak self] path in
      guard let self = self else { return }
      // Log EVERY update (they're rare — a handful per network transition): field evidence of
      // whether the monitor sees a given transition at all, which the emit-only log can't give.
      os_log("net path update: status=%{public}@ ifaces=%{public}@", log: Self.logHandle,
             type: .info, String(describing: path.status),
             path.availableInterfaces.map { $0.name }.joined(separator: ","))

      // Cache the latest class + attributes for currentNetworkClass() (change #2). For an
      // UNSATISFIED path we KEEP the last known class rather than overwrite it with "unknown":
      // getNetworkClass() is a best-effort coarse hint the JS layer normalizes, and a transient
      // loss is usually followed by a regain onto the same class — reporting the last-known class
      // is more useful (and matches what a caller mid-transition expects) than flapping to
      // "unknown". isExpensive/isConstrained still reflect this path so they stay in step. On the
      // very first update, if that first path is unsatisfied, the class stays "unknown" (its
      // initial value), which is correct — we have never seen a usable network.
      self.netStateLock.lock()
      if path.status == .satisfied || !self.netStateFresh {
        self.lastNetworkClass = Self.classify(path)
      }
      self.lastPathExpensive = path.isExpensive
      self.lastPathConstrained = path.isConstrained
      self.netStateFresh = true
      self.netStateLock.unlock()

      guard path.status == .satisfied else {
        // A LOSS invalidates the baseline (but never emits — bouncing the relay onto a dead
        // network would misfire the escalation chain). Android behaves the same way structurally:
        // onLost is silent, but the next onAvailable delivers a NEW Network token even for the
        // SAME Wi-Fi — so a loss→regain must nudge (the circuits died with the old connection).
        if self.lastNetSignature != nil { self.sawPathLoss = true }
        return
      }
      // Identity ≈ the set of usable interfaces (en0 vs pdp_ip0 …). NWPath can't see a same-
      // interface network swap (SSID→SSID) the way Android's Network token can, so the loss latch
      // above covers regains; attribute-only updates (isExpensive etc.) keep the signature and are
      // deduped, matching Android's "only a genuine change of the default network" rule.
      let signature = path.availableInterfaces.map { "\($0.name)#\($0.type)" }.joined(separator: ",")
      let prev = self.lastNetSignature
      let regained = self.sawPathLoss
      self.sawPathLoss = false
      self.lastNetSignature = signature
      if prev != nil, regained || prev != signature {
        let cls = Self.classify(path)
        os_log("default network changed → %{public}@ (regained=%{public}d hasListeners=%{public}d)",
               log: Self.logHandle, type: .info, cls, regained ? 1 : 0, self.hasListeners ? 1 : 0)
        if self.hasListeners {
          // iOS payload is a SUPERSET of Android's {networkClass}: it also carries the path's
          // NWPath cost hints (change #3). JS listeners ignore unknown fields, so this is purely
          // additive; Android's emitter keeps its {networkClass}-only shape and that's fine. The
          // debounce/when-to-fire semantics are unchanged — only the body grew.
          self.sendEvent(withName: "StiqTorNetworkChange", body: [
            "networkClass": cls,
            "isExpensive": path.isExpensive,
            "isConstrained": path.isConstrained,
          ])
        }
      }
    }
    monitor.start(queue: netMonitorQueue)
  }

  // ── Background quiesce window (change #1) ──────────────────────────────────────────────────────

  /// Observe app background/foreground once per process. Registered from the (one) real first start
  /// so neither observer can fire before the module and the daemon exist. Idempotent.
  private func registerQuiesceObservers() {
    bgTaskLock.lock()
    if quiesceObserversRegistered { bgTaskLock.unlock(); return }
    quiesceObserversRegistered = true
    bgTaskLock.unlock()

    NotificationCenter.default.addObserver(
      self, selector: #selector(handleDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(handleWillEnterForeground),
      name: UIApplication.willEnterForegroundNotification, object: nil)
  }

  /// On background: IF Tor has actually started, take a UIBackgroundTask assertion so the process is
  /// not suspended for ~30s. That window lets the JS-side 30s grace timer fire its designed quiesce
  /// (SIGNAL DORMANT + relay close) which the OS would otherwise freeze. We do NOT run the quiesce
  /// here — the JS layer owns it; this only keeps the process alive long enough for it to run. The
  /// expiration handler ends the task and clears the id so the OS is never left holding an assertion.
  @objc private func handleDidEnterBackground() {
    lifecycleLock.lock()
    let torStarted = started
    lifecycleLock.unlock()
    guard torStarted else { return }

    // UIApplication is main-thread-only; hop to main for both begin and the expiration handler.
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.bgTaskLock.lock()
      // Guard against double-begin (e.g. a rapid background→foreground→background flurry that
      // re-enters before the previous task was ended).
      if self.bgQuiesceTask != .invalid { self.bgTaskLock.unlock(); return }
      let task = UIApplication.shared.beginBackgroundTask(withName: "stiq.tor.quiesce") { [weak self] in
        // Expiration: the OS is reclaiming the assertion. End it and reset so the id is reusable.
        guard let self = self else { return }
        os_log("quiesce bg task: expired", log: Self.logHandle, type: .info)
        self.endQuiesceTask()
      }
      self.bgQuiesceTask = task
      self.bgTaskLock.unlock()
      os_log("quiesce bg task: begin (id=%{public}ld)", log: Self.logHandle, type: .info,
             task.rawValue)
    }
  }

  /// On foreground: end the assertion if still active (the JS grace timer is cancelled on foreground,
  /// so the window is no longer needed).
  @objc private func handleWillEnterForeground() {
    endQuiesceTask()
  }

  /// End the quiesce assertion and reset the identifier. Safe to call when none is held (no-op).
  /// Runs INLINE when already on the main thread — the expiration handler arrives on main and the OS
  /// expects the assertion ended synchronously inside it (an async hop risks the "task not ended
  /// before expiration" watchdog); off-main callers hop to the main queue for UIApplication.
  private func endQuiesceTask() {
    let body: () -> Void = { [weak self] in
      guard let self = self else { return }
      self.bgTaskLock.lock()
      let task = self.bgQuiesceTask
      self.bgQuiesceTask = .invalid
      self.bgTaskLock.unlock()
      guard task != .invalid else { return }
      UIApplication.shared.endBackgroundTask(task)
      os_log("quiesce bg task: end (id=%{public}ld)", log: Self.logHandle, type: .info,
             task.rawValue)
    }
    if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
  }

  // ── Pluggable transports (obfs4 / webtunnel / snowflake via IPtProxy) ────────────────────────

  #if canImport(IPtProxy)
  private static func startPluggableTransport(_ transport: String, stateDir: URL) throws -> Int {
    let ctrl: IPtProxyController
    if let existing = ptController {
      ctrl = existing
    } else {
      guard let c = IPtProxyNewController(stateDir.path, false, false, "ERR", nil) else {
        throw NSError(domain: "StiqTor", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "IPtProxy controller init failed"])
      }
      ptController = c
      ctrl = c
    }
    let method: String
    switch transport {
    case "snowflake": method = IPtProxySnowflake
    case "webtunnel": method = IPtProxyWebtunnel
    default:          method = IPtProxyObfs4
    }
    try ctrl.start(method, proxy: nil)
    let port = ctrl.port(method)
    guard port > 0 else {
      throw NSError(domain: "StiqTor", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "IPtProxy failed to start \(transport) (port=\(port))"])
    }
    return Int(port)
  }
  #else
  private static func startPluggableTransport(_ transport: String, stateDir: URL) throws -> Int {
    throw NSError(domain: "StiqTor", code: 4, userInfo: [NSLocalizedDescriptionKey:
      "pluggable transport \(transport) requires the IPtProxy pod; only 'direct' Tor is built"])
  }
  #endif
}

#else
// ── Tor.framework not bundled in this build ──────────────────────────────────────────────
// STIQ is Tor-only (config.ts ALLOW_CLEARNET_FALLBACK=false): a binary without Tor.framework is
// 100% non-functional, so compiling one must be a BUILD error, never a runtime string. The stub
// below exists solely for explicitly-opted-out tooling builds (STIQ_NO_TOR), which CI never sets.
#if !STIQ_NO_TOR
#error("Tor.framework missing: pod 'Tor' failed to resolve/link. A Tor-less stiq binary cannot reach the relay and must not build. Set STIQ_NO_TOR only for tooling builds that never ship.")
#endif

@objc(StiqTor)
class StiqTor: RCTEventEmitter {

  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! { ["StiqTorStatus", "StiqTorNetworkChange"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private func emit(_ body: [String: Any]) {
    if hasListeners { sendEvent(withName: "StiqTorStatus", body: body) }
  }

  @objc(startTor:resolver:rejecter:)
  func startTor(_ config: NSDictionary,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    emit(["kind": "starting"])
    emit(["kind": "error", "message": "Tor.framework not bundled — add pod 'Tor' to enable the bundled Tor daemon"])
    resolve(nil)
  }

  @objc(stopTor:rejecter:)
  func stopTor(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    emit(["kind": "stopped"])
    resolve(nil)
  }

  @objc(newCircuit:rejecter:)
  func newCircuit(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }
}
#endif
