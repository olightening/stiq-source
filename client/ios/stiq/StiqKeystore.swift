//
//  StiqKeystore.swift — hardware-backed secure storage.
//
//  iOS counterpart of android/.../StiqKeystoreModule.kt. Satisfies the JS SecureStorage
//  interface in client/src/keys/nativeKeystore.ts:
//      setItem(key, value)  -> Promise<void>
//      getItem(key)         -> Promise<string | null>
//      removeItem(key)      -> Promise<void>
//      multiGet(keys)       -> Promise<Record<string, string | null>>   (batched init read)
//
//  Values are stored as Keychain generic-password items with
//  kSecAttrAccessibleWhenUnlockedThisDeviceOnly: device-only (never synced to iCloud / another
//  device) and readable only while the device is unlocked. The item data is protected at rest by
//  the Secure-Enclave-backed class key. There is no export path.
//
//  LOCKED-DEVICE SEMANTICS (do NOT collapse into a nil-coalesce). A WhenUnlocked item read while the
//  device is locked returns errSecInteractionNotAllowed, which is NOT "key absent". Resolving null
//  there would make a locked read look like a fresh install and trip onboarding / duress. So a lock
//  rejects with a DISTINCT code (KEYSTORE_LOCKED); only errSecItemNotFound resolves null; every other
//  status rejects with the generic error. See client/src/keys/nativeKeystore.ts.
//
//  No biometric ACL: the app enforces its own PIN / duress-wipe lock layer (client/src/lock), and the
//  headless paths need to decrypt while the screen is locked-but-unlocked-once is NOT used here (we
//  stay WhenUnlocked, stronger than Android's posture). This matches the audit-#7 scope note in
//  client/src/keys/nativeKeystore.ts.
//

import Foundation
import Security
import UIKit

@objc(StiqKeystore)
class StiqKeystore: NSObject {

  /// Keychain service namespace. Keys map to kSecAttrAccount under this service.
  private let service = "com.stiq.client.secure"

  /// Distinct rejection code for "device locked, item unreadable" — callers MUST NOT treat this as
  /// a missing key. Kept separate from the generic KEYSTORE_ERROR on purpose.
  private let lockedCode = "KEYSTORE_LOCKED"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func baseQuery(_ key: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  // NOTE: there is deliberately NO `isProtectedDataAvailable()` pre-check. An earlier version read
  // `UIApplication.shared.isProtectedDataAvailable` before each read, which — off the main thread —
  // required a `DispatchQueue.main.sync` hop. On the cold-start hot path (init issues ~25-30 reads,
  // and App.tsx setup() awaits the very first one before it ever arms its init-timeout) that
  // main-queue sync deadlocked against the launch-time main runloop and pinned the app on the splash
  // forever. The pre-check was always redundant: a locked WhenUnlocked item makes SecItemCopyMatching
  // return errSecInteractionNotAllowed, which readOne() maps to .locked → the SAME KEYSTORE_LOCKED
  // rejection. setItem/removeItem already rely on that authoritative status with no pre-check; getItem
  // and multiGet now match them.

  // ── setItem: atomic upsert (SecItemUpdate → SecItemAdd on not-found) ─────────────────────────
  //
  // NEVER delete-then-add: a delete that succeeds followed by an add that fails leaves the nsec GONE
  // and unrecoverable (there is no other copy of a Nostr private key). SecItemUpdate is atomic — the
  // old value survives a failed write — and we only SecItemAdd when the item genuinely does not exist
  // yet. Parity intent with StiqKeystoreModule.kt:117's single writeText (no destructive window).
  @objc(setItem:value:resolver:rejecter:)
  func setItem(_ key: String,
               value: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let data = value.data(using: .utf8) else {
        reject("KEYSTORE_ERROR", "value not UTF-8 encodable", nil)
        return
      }

      // Try to update an existing item in place first (atomic; never destroys on failure).
      let updateStatus = SecItemUpdate(
        self.baseQuery(key) as CFDictionary,
        [kSecValueData as String: data] as CFDictionary
      )
      switch updateStatus {
      case errSecSuccess:
        resolve(nil)
      case errSecItemNotFound:
        // No existing item — add a fresh one with the accessibility class attached.
        var attrs = self.baseQuery(key)
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(attrs as CFDictionary, nil)
        if addStatus == errSecSuccess {
          resolve(nil)
        } else if addStatus == errSecInteractionNotAllowed {
          reject(self.lockedCode, "keystore locked: SecItemAdd (\(addStatus))", nil)
        } else {
          reject("KEYSTORE_ERROR", "SecItemAdd failed (\(addStatus))", nil)
        }
      case errSecInteractionNotAllowed:
        reject(self.lockedCode, "keystore locked: SecItemUpdate (\(updateStatus))", nil)
      default:
        reject("KEYSTORE_ERROR", "SecItemUpdate failed (\(updateStatus))", nil)
      }
    }
  }

  // ── getItem ──────────────────────────────────────────────────────────────────────────────────
  @objc(getItem:resolver:rejecter:)
  func getItem(_ key: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      switch self.readOne(key) {
      case .value(let str): resolve(str)
      case .absent: resolve(nil)
      case .locked: reject(self.lockedCode, "keystore locked (interaction not allowed)", nil)
      case .error(let status): reject("KEYSTORE_ERROR", "SecItemCopyMatching failed (\(status))", nil)
      }
    }
  }

  // ── multiGet: one native task, one bridge round-trip for ~25-30 init reads ───────────────────
  //
  // Returns { key: value | null }, null for any absent key (mirrors getItem). A LOCKED device rejects
  // the WHOLE batch with the locked code — identical to the JS Promise.all(getItem) fallback, where a
  // single locked read rejects the lot. See multiGet() in client/src/keys/nativeKeystore.ts.
  @objc(multiGet:resolver:rejecter:)
  func multiGet(_ keys: NSArray,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      var out: [String: Any] = [:]
      for element in keys {
        guard let key = element as? String else {
          reject("KEYSTORE_ERROR", "multiGet keys must be strings", nil)
          return
        }
        switch self.readOne(key) {
        case .value(let str): out[key] = str
        case .absent: out[key] = NSNull()
        case .locked: reject(self.lockedCode, "keystore locked (interaction not allowed)", nil); return
        case .error(let status): reject("KEYSTORE_ERROR", "SecItemCopyMatching failed (\(status))", nil); return
        }
      }
      resolve(out)
    }
  }

  @objc(removeItem:resolver:rejecter:)
  func removeItem(_ key: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      let status = SecItemDelete(self.baseQuery(key) as CFDictionary)
      if status == errSecSuccess || status == errSecItemNotFound {
        resolve(nil)
      } else if status == errSecInteractionNotAllowed {
        reject(self.lockedCode, "keystore locked: SecItemDelete (\(status))", nil)
      } else {
        reject("KEYSTORE_ERROR", "SecItemDelete failed (\(status))", nil)
      }
    }
  }

  // ── copySensitive: pasteboard write for npub/nsec/join-code text ────────────────────────────
  //
  // Plain Clipboard.setString (the RN clipboard package) writes a pasteboard item that syncs via
  // Universal Clipboard to the user's other signed-in Apple devices and has no expiry — fine for a
  // shared post link, wrong for a join code or a key. `.localOnly` keeps the item on THIS device only
  // and `.expirationDate` makes iOS purge it from pasteboard history on its own after 2 minutes, so a
  // copy-then-forget doesn't leave sensitive text sitting in clipboard managers/history indefinitely.
  // Fire-and-forget (no resolver/rejecter): a pasteboard write is not a fallible operation the caller
  // needs to react to, and JS has no fallback path for a rejection here anyway.
  @objc(copySensitive:)
  func copySensitive(_ text: String) {
    DispatchQueue.main.async {
      UIPasteboard.general.setItems(
        [["public.utf8-plain-text": text]],
        options: [
          .localOnly: true,
          .expirationDate: Date(timeIntervalSinceNow: 120),
        ]
      )
    }
  }

  // ── shared read ──────────────────────────────────────────────────────────────────────────────

  private enum ReadResult {
    case value(String)
    case absent
    case locked
    case error(OSStatus)
  }

  /// One Keychain read, mapped to the four outcomes the contract distinguishes. Crucially keeps
  /// errSecItemNotFound (absent → null) SEPARATE from errSecInteractionNotAllowed (locked → reject).
  private func readOne(_ key: String) -> ReadResult {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      if let data = item as? Data, let str = String(data: data, encoding: .utf8) {
        return .value(str)
      }
      // Present but not decodable as UTF-8 — treat as a hard error, never as absent.
      return .error(status)
    case errSecItemNotFound:
      return .absent
    case errSecInteractionNotAllowed:
      return .locked
    default:
      return .error(status)
    }
  }
}
