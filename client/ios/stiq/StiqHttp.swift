// StiqHttp.swift — iOS Tor-routed HTTP fetch. Mirrors Android StiqHttpModule and the JS contract
// in src/media/torHttp.ts:
//   request({method,url,socksHost,socksPort,socksUser,socksPass,headers,bodyBase64,maxBytes,timeoutMs})
//     -> { status, headers, bodyBase64 }
//
// Like Android, it does ONE request (TS follows redirects) over a raw socket to the local Tor
// SOCKS5 port, sending the host to the proxy for REMOTE resolution (no DNS leak), then upgrades
// to TLS for https via CFStream's security level + SNI. Circuit isolation via SOCKS user/pass.
//
// NOTE: a full-page WebView over Tor is possible on iOS 17+ via WKWebsiteDataStore.proxyConfigurations,
// but the deployment floor is 15.1, so SafeWebView stays reader-mode on iOS (fetch-over-Tor → extract).
// This module is that reader-mode fetch path.

import Foundation
import React

@objc(StiqHttp)
class StiqHttpModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(request:resolver:rejecter:)
  func request(_ opts: NSDictionary,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let result = try self.perform(opts)
        resolve(result)
      } catch {
        reject("HTTP_ERROR", error.localizedDescription, error)
      }
    }
  }

  private func perform(_ opts: NSDictionary) throws -> [String: Any] {
    let method = (opts["method"] as? String) ?? "GET"
    guard let urlStr = opts["url"] as? String, let url = URL(string: urlStr),
          let host = url.host else { throw Err.msg("bad url") }
    let https = (url.scheme?.lowercased() == "https")
    let port = url.port ?? (https ? 443 : 80)
    let socksHost = (opts["socksHost"] as? String) ?? "127.0.0.1"
    let socksPort = (opts["socksPort"] as? Int) ?? 9050
    let user = (opts["socksUser"] as? String) ?? ""
    let pass = (opts["socksPass"] as? String) ?? ""
    let maxBytes = (opts["maxBytes"] as? Int) ?? 5 * 1024 * 1024
    let timeoutMs = (opts["timeoutMs"] as? Int) ?? 30_000
    let headers = (opts["headers"] as? [String: String]) ?? [:]
    let bodyB64 = (opts["bodyBase64"] as? String) ?? ""

    var input: InputStream?
    var output: OutputStream?
    Stream.getStreamsToHost(withName: socksHost, port: socksPort, inputStream: &input, outputStream: &output)
    guard let inp = input, let out = output else { throw Err.msg("cannot open socket") }
    inp.open(); out.open()
    defer { inp.close(); out.close() }

    try socks5Connect(inp, out, host: host, port: port, user: user, pass: pass)

    if https {
      // Upgrade the proxied stream to TLS with SNI = host.
      let settings: [String: Any] = [
        kCFStreamSSLPeerName as String: host,
        kCFStreamSSLValidatesCertificateChain as String: true,
      ]
      inp.setProperty(StreamSocketSecurityLevel.negotiatedSSL.rawValue, forKey: .socketSecurityLevelKey)
      out.setProperty(StreamSocketSecurityLevel.negotiatedSSL.rawValue, forKey: .socketSecurityLevelKey)
      inp.setProperty(settings, forKey: Stream.PropertyKey(kCFStreamPropertySSLSettings as String))
      out.setProperty(settings, forKey: Stream.PropertyKey(kCFStreamPropertySSLSettings as String))
    }

    try writeRequest(out, method: method, host: host, port: port, https: https,
                     path: url.path.isEmpty ? "/" : url.path + (url.query.map { "?\($0)" } ?? ""),
                     headers: headers, bodyB64: bodyB64, timeoutMs: timeoutMs)

    let (status, respHeaders, body) = try readResponse(inp, maxBytes: maxBytes, isHead: method.uppercased() == "HEAD")
    return [
      "status": status,
      "headers": respHeaders,
      "bodyBase64": Data(body).base64EncodedString(),
    ]
  }

  // MARK: - SOCKS5 (RFC 1928) + optional user/pass auth (RFC 1929)

  private func socks5Connect(_ inp: InputStream, _ out: OutputStream,
                             host: String, port: Int, user: String, pass: String) throws {
    let useAuth = !user.isEmpty || !pass.isEmpty
    try write(out, useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00])
    let sel = try read(inp, 2)
    guard sel[0] == 0x05 else { throw Err.msg("bad socks version") }
    if sel[1] == 0x02 {
      let u = Array(user.utf8), p = Array(pass.utf8)
      var req: [UInt8] = [0x01, UInt8(u.count)] + u + [UInt8(p.count)] + p
      try write(out, req); req.removeAll()
      let ar = try read(inp, 2)
      guard ar[1] == 0x00 else { throw Err.msg("socks auth failed") }
    } else if sel[1] != 0x00 {
      throw Err.msg("socks auth refused")
    }
    let h = Array(host.utf8)
    var conn: [UInt8] = [0x05, 0x01, 0x00, 0x03, UInt8(h.count)] + h
    conn += [UInt8((port >> 8) & 0xff), UInt8(port & 0xff)]
    try write(out, conn)
    let rep = try read(inp, 4)
    guard rep[1] == 0x00 else { throw Err.msg("socks connect failed \(rep[1])") }
    switch rep[3] {
    case 0x01: _ = try read(inp, 6)
    case 0x04: _ = try read(inp, 18)
    case 0x03: let l = Int(try read(inp, 1)[0]); _ = try read(inp, l + 2)
    default: throw Err.msg("socks bad atyp")
    }
  }

  // MARK: - HTTP/1.1

  private func writeRequest(_ out: OutputStream, method: String, host: String, port: Int,
                            https: Bool, path: String, headers: [String: String],
                            bodyB64: String, timeoutMs: Int) throws {
    let body = bodyB64.isEmpty ? Data() : (Data(base64Encoded: bodyB64) ?? Data())
    let hostHeader = ((https && port == 443) || (!https && port == 80)) ? host : "\(host):\(port)"
    var req = "\(method) \(path) HTTP/1.1\r\nHost: \(hostHeader)\r\n"
    var hasUA = false
    for (k, v) in headers {
      let lk = k.lowercased()
      if lk == "referer" || lk == "cookie" || lk == "host" { continue }
      if lk == "user-agent" { hasUA = true }
      req += "\(k): \(v)\r\n"
    }
    if !hasUA { req += "User-Agent: Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0\r\n" }
    if !body.isEmpty { req += "Content-Length: \(body.count)\r\n" }
    req += "Connection: close\r\n\r\n"
    try write(out, Array(req.utf8))
    if !body.isEmpty { try write(out, [UInt8](body)) }
  }

  private func readResponse(_ inp: InputStream, maxBytes: Int, isHead: Bool) throws -> (Int, [String: String], [UInt8]) {
    var buffer = [UInt8]()
    // Read until end of headers (CRLFCRLF).
    while !endsWithDoubleCRLF(buffer) {
      let chunk = try read(inp, 1)
      buffer.append(chunk[0])
      if buffer.count > 64 * 1024 { throw Err.msg("header too large") }
    }
    let headerText = String(bytes: buffer, encoding: .utf8) ?? ""
    let lines = headerText.components(separatedBy: "\r\n")
    let statusParts = (lines.first ?? "").components(separatedBy: " ")
    guard statusParts.count >= 2, let status = Int(statusParts[1]) else { throw Err.msg("bad status") }
    var headers = [String: String]()
    for line in lines.dropFirst() where line.contains(":") {
      let idx = line.firstIndex(of: ":")!
      headers[String(line[..<idx]).lowercased()] = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
    }
    if isHead || status == 204 || status == 304 { return (status, headers, []) }

    var body = [UInt8]()
    if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
      while true {
        var sizeLine = ""
        while !sizeLine.hasSuffix("\r\n") { sizeLine += String(UnicodeScalar(try read(inp, 1)[0])) }
        let size = Int(sizeLine.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: ";")[0], radix: 16) ?? 0
        if size == 0 { break }
        if body.count + size > maxBytes { throw Err.msg("response exceeds cap") }
        body += try read(inp, size)
        _ = try read(inp, 2) // trailing CRLF
      }
    } else if let len = headers["content-length"].flatMap({ Int($0) }) {
      if len > maxBytes { throw Err.msg("response exceeds cap") }
      if len > 0 { body = try read(inp, len) }
    } else {
      while inp.hasBytesAvailable {
        let chunk = try read(inp, 1)
        body.append(chunk[0])
        if body.count > maxBytes { throw Err.msg("response exceeds cap") }
      }
    }
    return (status, headers, body)
  }

  // MARK: - Stream helpers

  private func write(_ out: OutputStream, _ bytes: [UInt8]) throws {
    var sent = 0
    while sent < bytes.count {
      let n = bytes[sent...].withUnsafeBufferPointer { out.write($0.baseAddress!, maxLength: bytes.count - sent) }
      if n <= 0 { throw Err.msg("write failed") }
      sent += n
    }
  }

  private func read(_ inp: InputStream, _ n: Int) throws -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: n)
    var off = 0
    let deadline = Date().addingTimeInterval(30)
    while off < n {
      if !inp.hasBytesAvailable {
        if Date() > deadline { throw Err.msg("read timeout") }
        Thread.sleep(forTimeInterval: 0.005)
        continue
      }
      let r = buf[off...].withUnsafeMutableBufferPointer { inp.read($0.baseAddress!, maxLength: n - off) }
      if r <= 0 { throw Err.msg("eof") }
      off += r
    }
    return buf
  }

  private func endsWithDoubleCRLF(_ b: [UInt8]) -> Bool {
    let n = b.count
    return n >= 4 && b[n - 4] == 13 && b[n - 3] == 10 && b[n - 2] == 13 && b[n - 1] == 10
  }

  enum Err: Error, LocalizedError { case msg(String); var errorDescription: String? { if case .msg(let m) = self { return m }; return nil } }
}
