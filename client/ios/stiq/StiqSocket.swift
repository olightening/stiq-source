//
//  StiqSocket.swift — WebSocket tunnelled through Tor's SOCKS5 proxy.
//  iOS counterpart of android/.../StiqSocketModule.kt. Implemented from the JS contract
//  (client/src/nostr/torSocket.ts), NOT from the old 3-arg scaffold.
//
//  JS contract (client/src/nostr/torSocket.ts:17-34):
//      connect(socketId, url, socksHost, socksPort, socksUser, socksPass) -> Promise<void>
//      send(socketId, message)                                            -> Promise<void>
//      close(socketId)                                                    -> Promise<void>
//  Emits "StiqSocket" events, EACH tagged with its socketId:
//      {socketId, type:"open"} / {socketId, type:"message", data} /
//      {socketId, type:"error", data} / {socketId, type:"close"}
//
//  The RN module is process-global, but the app runs a long-lived feed socket alongside
//  short-lived enrollment / token-draw / blind-publish sockets, ALL at once. State and events are
//  therefore keyed by socketId (a [String: Connection] dict), exactly like the Kotlin module — one
//  module instance can never be one connection.
//
//  CIRCUIT ISOLATION (audit #1 / #49 — the whole point of this module): every connect carries a
//  per-session SOCKS username+password (the socketId). Tor's IsolateSOCKSAuth gives each distinct
//  credential pair its OWN circuit, so the identity-scoped feed REQs and a blind-post publish never
//  share a circuit. A NO-AUTH stream carries no isolation signature and would silently collapse
//  every socket onto one circuit — full deanonymization with no error. So we send
//  [0x05,0x02,0x00,0x02] (offer NO-AUTH + USER/PASS), do the RFC 1929 user/pass exchange, and
//  REJECT an empty credential (parity with StiqSocketModule.kt:201-204) — an empty user/pass is a
//  caller bug, and failing loud beats de-isolating silently.
//
//  The .onion hostname is sent to the proxy for REMOTE resolution (SOCKS5 ATYP=domain) — never
//  resolved locally, so there is no DNS leak. NSURLSession / Network.framework cannot be pointed at
//  a SOCKS5 proxy on iOS, so a raw POSIX socket is the correct primitive.
//

import Foundation
import Darwin

@objc(StiqSocket)
class StiqSocket: RCTEventEmitter {

  private var hasListeners = false

  /// One live tunnel. All mutable fields are guarded by `lock`.
  private final class Connection {
    let lock = NSLock()
    var sockfd: Int32 = -1
    var closed = false
  }

  /// Keyed by socketId. Its own lock guards the map itself (insert/lookup/remove).
  private var connections: [String: Connection] = [:]
  private let mapLock = NSLock()

  enum SocketError: Error { case fail(String) }

  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! { ["StiqSocket"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private func emit(_ socketId: String, _ type: String, _ data: String?) {
    guard hasListeners else { return }
    var body: [String: Any] = ["socketId": socketId, "type": type]
    if let d = data { body["data"] = d }
    sendEvent(withName: "StiqSocket", body: body)
  }

  // ── map helpers ────────────────────────────────────────────────────────────────────────────

  private func putConnection(_ socketId: String, _ connection: Connection) -> Connection? {
    mapLock.lock(); defer { mapLock.unlock() }
    let prior = connections[socketId]
    connections[socketId] = connection
    return prior
  }

  private func currentConnection(_ socketId: String) -> Connection? {
    mapLock.lock(); defer { mapLock.unlock() }
    return connections[socketId]
  }

  /// Remove `connection` from the map ONLY if it is still the one registered for `socketId`
  /// (a newer connect for the same id must not be evicted by an older reader's teardown).
  /// Returns true when this call is the one that removed it — the single owner of the terminal event.
  @discardableResult
  private func removeConnection(_ socketId: String, _ connection: Connection) -> Bool {
    mapLock.lock(); defer { mapLock.unlock() }
    if connections[socketId] === connection {
      connections.removeValue(forKey: socketId)
      return true
    }
    return false
  }

  // ── React methods ──────────────────────────────────────────────────────────────────────────

  @objc(connect:url:socksHost:socksPort:socksUser:socksPass:resolver:rejecter:)
  func connect(_ socketId: String,
               url: String,
               socksHost: String,
               socksPort: NSNumber,
               socksUser: String,
               socksPass: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {

    // Fail CLOSED before opening anything: an empty SOCKS credential means no per-socket circuit
    // isolation (see the class header). Parity with StiqSocketModule.kt:201-204 — reject, loudly.
    if socksUser.isEmpty || socksPass.isEmpty {
      reject("WS_ERROR", "SOCKS isolation credentials required", nil)
      return
    }

    let connection = Connection()
    // Register first; if an older connection was under this id, tear it down (matches Kotlin's
    // `connections.put(id, c)?.let(::closeConnection)`).
    if let prior = putConnection(socketId, connection) {
      closeConnection(prior)
    }

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        guard let comps = URLComponents(string: url), let host = comps.host else {
          throw SocketError.fail("invalid url")
        }
        let port = comps.port ?? 80
        let path = (comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath)
          + (comps.percentEncodedQuery.map { "?\($0)" } ?? "")

        let fd = try self.tcpConnect(socksHost, Int32(socksPort.intValue))
        do {
          try self.socks5Connect(fd, host: host, port: port, user: socksUser, pass: socksPass)
          try self.wsHandshake(fd, host: host, port: port, path: path)
        } catch {
          Darwin.close(fd)
          throw error
        }

        // A newer connect for this id (or a close) may have replaced us while we handshook.
        if self.currentConnection(socketId) !== connection {
          Darwin.close(fd)
          return
        }
        connection.lock.lock()
        if connection.closed {
          connection.lock.unlock()
          Darwin.close(fd)
          return
        }
        connection.sockfd = fd
        connection.lock.unlock()

        self.emit(socketId, "open", nil)
        resolve(nil)

        self.readLoop(fd, socketId: socketId, connection: connection)
      } catch {
        // Only the owning connection reports the failure, and only if it hasn't been superseded.
        if self.removeConnection(socketId, connection) {
          self.emit(socketId, "error", error.localizedDescription)
        }
        self.closeConnection(connection)
        reject("WS_ERROR", error.localizedDescription, nil)
      }
    }
  }

  @objc(send:message:resolver:rejecter:)
  func send(_ socketId: String,
            message: String,
            resolver resolve: @escaping RCTPromiseResolveBlock,
            rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let connection = currentConnection(socketId) else {
      reject("WS_CLOSED", "socket not open", nil)
      return
    }
    connection.lock.lock()
    let fd = connection.sockfd
    let closed = connection.closed
    connection.lock.unlock()
    guard !closed, fd >= 0 else { reject("WS_CLOSED", "socket not open", nil); return }
    do {
      try writeFrame(connection, opcode: 0x1, payload: Array(message.utf8))
      resolve(nil)
    } catch {
      reject("WS_CLOSED", error.localizedDescription, nil)
    }
  }

  @objc(close:resolver:rejecter:)
  func close(_ socketId: String,
             resolver resolve: @escaping RCTPromiseResolveBlock,
             rejecter reject: @escaping RCTPromiseRejectBlock) {
    mapLock.lock()
    let connection = connections.removeValue(forKey: socketId)
    mapLock.unlock()
    if let c = connection { closeConnection(c) }
    resolve(nil)
  }

  // ── SOCKS5 + WebSocket handshake ─────────────────────────────────────────────────────────────

  private func socks5Connect(_ fd: Int32, host: String, port: Int, user: String, pass: String) throws {
    // Offer NO-AUTH + USER/PASS (RFC 1929). See the class header for why NO-AUTH-only fails open.
    try writeAll(fd, [0x05, 0x02, 0x00, 0x02])
    let sel = try readFully(fd, 2)
    if sel[0] != 0x05 { throw SocketError.fail("bad SOCKS version") }
    switch sel[1] {
    case 0x00:
      break // proxy chose NO-AUTH — acceptable
    case 0x02:
      let u = Array(user.utf8), p = Array(pass.utf8)
      var auth: [UInt8] = [0x01, UInt8(u.count)] + u + [UInt8(p.count)] + p
      try writeAll(fd, auth); auth.removeAll()
      let ar = try readFully(fd, 2)
      if ar[1] != 0x00 { throw SocketError.fail("SOCKS auth failed") }
    default:
      throw SocketError.fail("SOCKS auth refused")
    }

    let h = Array(host.utf8)
    var req: [UInt8] = [0x05, 0x01, 0x00, 0x03, UInt8(h.count)]  // CONNECT, ATYP=domain
    req.append(contentsOf: h)
    req.append(UInt8((port >> 8) & 0xff))
    req.append(UInt8(port & 0xff))
    try writeAll(fd, req)

    let rep = try readFully(fd, 4)                   // VER, REP, RSV, ATYP
    if rep[1] != 0x00 { throw SocketError.fail("SOCKS connect failed rep=\(rep[1])") }
    switch rep[3] {
    case 0x01: _ = try readFully(fd, 6)              // IPv4 + port
    case 0x04: _ = try readFully(fd, 18)             // IPv6 + port
    case 0x03: let l = Int(try readFully(fd, 1)[0]); _ = try readFully(fd, l + 2)
    default: throw SocketError.fail("SOCKS bad ATYP")
    }
  }

  private func wsHandshake(_ fd: Int32, host: String, port: Int, path: String) throws {
    var key = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, key.count, &key)
    let keyB64 = Data(key).base64EncodedString()
    let hostHeader = port == 80 ? host : "\(host):\(port)"
    let req = "GET \(path) HTTP/1.1\r\n"
      + "Host: \(hostHeader)\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Key: \(keyB64)\r\n"
      + "Sec-WebSocket-Version: 13\r\n\r\n"
    try writeAll(fd, Array(req.utf8))

    var bytes = [UInt8]()
    while true {
      let b = readOne(fd)
      if b < 0 { throw SocketError.fail("WS handshake EOF") }
      bytes.append(UInt8(b))
      if bytes.count >= 4
        && bytes[bytes.count - 4] == 0x0d && bytes[bytes.count - 3] == 0x0a
        && bytes[bytes.count - 2] == 0x0d && bytes[bytes.count - 1] == 0x0a { break }
    }
    let head = String(decoding: bytes, as: UTF8.self)
    let status = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
    if !status.contains("101") { throw SocketError.fail("WS upgrade failed: \(status)") }
  }

  // ── Frame I/O ──────────────────────────────────────────────────────────────────────────────

  private func readLoop(_ fd: Int32, socketId: String, connection: Connection) {
    var message = [UInt8]()
    do {
      while self.currentConnection(socketId) === connection {
        let b0 = readOne(fd)
        if b0 < 0 { break }
        let opcode = b0 & 0x0F
        let fin = (b0 & 0x80) != 0
        let b1 = readOne(fd)
        if b1 < 0 { break }
        let masked = (b1 & 0x80) != 0
        var len = UInt64(b1 & 0x7F)
        if len == 126 {
          let e = try readFully(fd, 2)
          len = (UInt64(e[0]) << 8) | UInt64(e[1])
        } else if len == 127 {
          let e = try readFully(fd, 8)
          len = 0
          for i in 0..<8 { len = (len << 8) | UInt64(e[i]) }
        }
        let mask = masked ? try readFully(fd, 4) : nil
        var payload = try readFully(fd, Int(len))
        if let m = mask {
          for i in 0..<payload.count { payload[i] ^= m[i % 4] }
        }

        switch opcode {
        case 0x1, 0x0:
          message.append(contentsOf: payload)
          if fin {
            let text = String(decoding: message, as: UTF8.self)
            message.removeAll(keepingCapacity: true)
            if currentConnection(socketId) === connection { emit(socketId, "message", text) }
          }
        case 0x9:                                   // ping -> pong
          try? writeFrame(connection, opcode: 0xA, payload: payload)
        case 0x8:                                    // close
          break
        default:                                     // 0xA pong: ignore
          break
        }
        if opcode == 0x8 { break }
      }
    } catch {
      // fall through to close
    }
    if removeConnection(socketId, connection) {
      emit(socketId, "close", nil)
    }
    closeConnection(connection)
  }

  /// Write a client frame (always masked, single FIN frame). Serialized on the connection lock.
  private func writeFrame(_ connection: Connection, opcode: Int, payload: [UInt8]) throws {
    connection.lock.lock()
    defer { connection.lock.unlock() }
    guard !connection.closed, connection.sockfd >= 0 else { throw SocketError.fail("socket closed") }
    let fd = connection.sockfd
    var header = [UInt8]()
    header.append(UInt8(0x80 | opcode))
    let len = payload.count
    if len < 126 {
      header.append(UInt8(0x80 | len))
    } else if len < 65536 {
      header.append(0x80 | 126)
      header.append(UInt8((len >> 8) & 0xff))
      header.append(UInt8(len & 0xff))
    } else {
      header.append(0x80 | 127)
      for i in stride(from: 7, through: 0, by: -1) {
        header.append(UInt8((UInt64(len) >> (8 * UInt64(i))) & 0xff))
      }
    }
    var mask = [UInt8](repeating: 0, count: 4)
    _ = SecRandomCopyBytes(kSecRandomDefault, 4, &mask)
    header.append(contentsOf: mask)
    var masked = [UInt8](repeating: 0, count: len)
    for i in 0..<len { masked[i] = payload[i] ^ mask[i % 4] }
    try writeAllRaw(fd, header)
    try writeAllRaw(fd, masked)
  }

  // ── Raw POSIX socket helpers ─────────────────────────────────────────────────────────────────

  private func tcpConnect(_ host: String, _ port: Int32) throws -> Int32 {
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    hints.ai_socktype = SOCK_STREAM
    hints.ai_protocol = IPPROTO_TCP
    var res: UnsafeMutablePointer<addrinfo>?
    let rc = getaddrinfo(host, String(port), &hints, &res)
    guard rc == 0, let first = res else { throw SocketError.fail("getaddrinfo \(host):\(port) failed") }
    defer { freeaddrinfo(res) }

    var fd: Int32 = -1
    var p: UnsafeMutablePointer<addrinfo>? = first
    while let info = p {
      fd = socket(info.pointee.ai_family, info.pointee.ai_socktype, info.pointee.ai_protocol)
      if fd >= 0 {
        if Darwin.connect(fd, info.pointee.ai_addr, info.pointee.ai_addrlen) == 0 { break }
        Darwin.close(fd); fd = -1
      }
      p = info.pointee.ai_next
    }
    if fd < 0 { throw SocketError.fail("connect failed to \(host):\(port)") }
    enableKeepalive(fd)
    return fd
  }

  /// Turn on TCP keepalive for the just-connected fd. `tcpConnect` is only ever called with
  /// (socksHost, socksPort) — 127.0.0.1 and the in-process Tor daemon's local SOCKS listener (see
  /// StiqTor.swift, which only ever reports "127.0.0.1" as `socks.host`) — so this is always a LOCAL
  /// loopback socket, never a socket to a remote host. That means these probes never touch the
  /// network: they exist purely to detect the local Tor SOCKS end dying (e.g. the process was
  /// suspended and Tor's side of the loopback pipe got torn down) faster than the JS layer's 90-second
  /// relay watchdog would notice a silently-dead fd. Tor-level KeepalivePeriod was deliberately
  /// dropped on iOS (see StiqTor.swift's "DROPPED vs Android" comment) because Path A suspends the
  /// process and a Tor-side keepalive can't fire when it would matter — this is a different,
  /// unrelated mechanism (kernel-level, local-only) and does not reintroduce that.
  /// Best-effort: any setsockopt failure here is non-fatal and silently ignored, matching this file's
  /// existing style of not logging (there is no logger in this file — failures surface only via
  /// thrown SocketError / emitted events, and a keepalive misconfiguration shouldn't kill a socket
  /// that otherwise connected fine).
  private func enableKeepalive(_ fd: Int32) {
    var one: Int32 = 1
    _ = withUnsafePointer(to: &one) {
      setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, $0, socklen_t(MemoryLayout<Int32>.size))
    }
    // Darwin has no TCP_KEEPIDLE — TCP_KEEPALIVE is the (differently-named) equivalent: idle seconds
    // before the first probe.
    var idle: Int32 = 60
    _ = withUnsafePointer(to: &idle) {
      setsockopt(fd, IPPROTO_TCP, TCP_KEEPALIVE, $0, socklen_t(MemoryLayout<Int32>.size))
    }
    var interval: Int32 = 30
    _ = withUnsafePointer(to: &interval) {
      setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, $0, socklen_t(MemoryLayout<Int32>.size))
    }
    var count: Int32 = 3
    _ = withUnsafePointer(to: &count) {
      setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, $0, socklen_t(MemoryLayout<Int32>.size))
    }
  }

  private func writeAll(_ fd: Int32, _ data: [UInt8]) throws { try writeAllRaw(fd, data) }

  private func writeAllRaw(_ fd: Int32, _ data: [UInt8]) throws {
    var off = 0
    try data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      while off < data.count {
        let n = write(fd, base + off, data.count - off)
        if n <= 0 { throw SocketError.fail("write failed") }
        off += n
      }
    }
  }

  private func readFully(_ fd: Int32, _ n: Int) throws -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: max(n, 0))
    if n <= 0 { return buf }
    var off = 0
    try buf.withUnsafeMutableBytes { raw in
      guard let base = raw.baseAddress else { return }
      while off < n {
        let r = read(fd, base + off, n - off)
        if r <= 0 { throw SocketError.fail("EOF") }
        off += r
      }
    }
    return buf
  }

  private func readOne(_ fd: Int32) -> Int {
    var b: UInt8 = 0
    let r = read(fd, &b, 1)
    return r == 1 ? Int(b) : -1
  }

  private func closeConnection(_ connection: Connection) {
    connection.lock.lock()
    if connection.closed { connection.lock.unlock(); return }
    connection.closed = true
    let fd = connection.sockfd
    connection.sockfd = -1
    connection.lock.unlock()
    if fd >= 0 { Darwin.close(fd) }
  }
}
