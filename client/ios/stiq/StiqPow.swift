//
//  StiqPow.swift — NIP-13 proof-of-work miner (iOS counterpart of StiqPowModule.kt).
//
//  The relay gates DM gift wraps (kind 1059) on ~20-bit PoW. Mining that in Hermes JS is
//  far too slow; native SHA-256 (CommonCrypto, hardware-accelerated) does it sub-second.
//
//  JS contract (client/src/dm/dm.ts):
//      minePow(serialized, nonceOffset, nonceWidth, difficulty) -> Promise<string>
//
//  The caller pre-serializes the NIP-01 event with a fixed-width, zero-padded nonce
//  placeholder and passes the placeholder's byte offset. We rewrite only those digit bytes
//  each attempt and hash the buffer until the id has enough leading zero bits, then return
//  the winning nonce as a decimal string (JS pads it back to width and finalizes/signs).
//
//  Byte-for-byte identical to the Kotlin miner: count starts at 0 and is pre-incremented,
//  so the first attempt is 1; the nonce field is fully overwritten with the zero-padded
//  decimal of count (high-order positions become '0' once the value is exhausted).
//

import Foundation
import CommonCrypto

@objc(StiqPow)
class StiqPow: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(minePow:nonceOffset:nonceWidth:difficulty:resolver:rejecter:)
  func minePow(_ serialized: String,
               nonceOffset: NSNumber,
               nonceWidth: NSNumber,
               difficulty: NSNumber,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      var bytes = Array(serialized.utf8)
      let off = nonceOffset.intValue
      let width = nonceWidth.intValue
      let diff = difficulty.intValue

      guard off >= 0, width > 0, off + width <= bytes.count else {
        reject("POW_ERROR", "nonce field [\(off),\(off + width)) out of range for \(bytes.count) bytes", nil)
        return
      }

      var count: UInt64 = 0
      var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))

      bytes.withUnsafeMutableBufferPointer { buf in
        let base = buf.baseAddress!
        let total = CC_LONG(buf.count)
        while true {
          count &+= 1
          var n = count
          var i = off + width - 1
          while i >= off {
            buf[i] = UInt8(48 &+ (n % 10))
            n /= 10
            i -= 1
          }
          digest.withUnsafeMutableBufferPointer { d in
            _ = CC_SHA256(base, total, d.baseAddress)
          }
          if StiqPow.leadingZeroBits(digest) >= diff { break }
        }
      }

      resolve(String(count))
    }
  }

  /// Leading zero bits of a raw 32-byte hash — the relay's exact NIP-13 difficulty check.
  private static func leadingZeroBits(_ hash: [UInt8]) -> Int {
    var count = 0
    for b in hash {
      if b == 0 {
        count += 8
        continue
      }
      count += b.leadingZeroBitCount // UInt8: 0...7 for a non-zero byte
      break
    }
    return count
  }
}
