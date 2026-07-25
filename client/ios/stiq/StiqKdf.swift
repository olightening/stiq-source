// StiqKdf.swift — PIN key derivation. JS contract in src/lock/nativeKdf.ts:
//   pbkdf2(pin, saltHex, iterations, dkLenBytes) -> hex string
//
// PBKDF2-HMAC-SHA256 via CommonCrypto (CCKeyDerivationPBKDF). RFC 8018, so byte-identity with the
// pure-JS fallback (@noble pbkdf2Async(sha256)) in nativeKdf.ts is EXPECTED — that fallback is the
// test oracle. No secret is retained; the key is derived and returned as hex to the caller.

import Foundation
import CommonCrypto

@objc(StiqKdf)
class StiqKdf: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(pbkdf2:saltHex:iterations:dkLenBytes:resolver:rejecter:)
  func pbkdf2(_ pin: String, saltHex: String, iterations: NSNumber, dkLenBytes: NSNumber,
              resolver resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let salt = Self.hexToBytes(saltHex) else {
        reject("KDF_ERROR", "saltHex is not valid hex", nil); return
      }
      let pinBytes = Array(pin.utf8)
      let dkLen = max(dkLenBytes.intValue, 1)
      let rounds = UInt32(max(iterations.intValue, 1))
      var derived = [UInt8](repeating: 0, count: dkLen)

      let status = pinBytes.withUnsafeBufferPointer { pinPtr in
        salt.withUnsafeBufferPointer { saltPtr in
          CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2),
            // PBEKeySpec-style: the PIN chars as the password bytes.
            pinPtr.baseAddress?.withMemoryRebound(to: Int8.self, capacity: pinBytes.count) { $0 },
            pinBytes.count,
            saltPtr.baseAddress, salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
            rounds,
            &derived, dkLen
          )
        }
      }
      if status == kCCSuccess {
        resolve(derived.map { String(format: "%02x", $0) }.joined())
      } else {
        reject("KDF_ERROR", "CCKeyDerivationPBKDF failed (\(status))", nil)
      }
    }
  }

  private static func hexToBytes(_ hex: String) -> [UInt8]? {
    let chars = Array(hex)
    guard chars.count % 2 == 0 else { return nil }
    var out = [UInt8](); out.reserveCapacity(chars.count / 2)
    var i = 0
    while i < chars.count {
      guard let b = UInt8(String(chars[i...i+1]), radix: 16) else { return nil }
      out.append(b); i += 2
    }
    return out
  }
}
