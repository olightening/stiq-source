// StiqWebProxy.swift — browser hand-off + web-data helpers. JS contract in src/browser/browserData.ts
// (all methods optional / fail-soft):
//   isAppInstalled(id)      -> Bool     (canOpenURL "<id>://")
//   openInApp(url, id)      -> Bool     (open <url> in the app claiming scheme <id>)
//   clearBrowsingData()     -> void     (wipe WKWebsiteDataStore)
//   listInstalledBrowsers() -> [{package,label}]
//   isSupported()           -> false    (WKWebView can't be per-app SOCKS-proxied below iOS 17; floor 15.1)
//
// iOS has no full-page Tor WebView here, so `isSupported` stays false and SafeWebView remains
// reader-mode (leak-free fetch-over-Tor). These helpers only cover the "open in another app" affordance.

import Foundation
import React
import UIKit
import WebKit

@objc(StiqWebProxy)
class StiqWebProxy: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { true } // UIApplication.open / canOpenURL are main-thread

  // Known Tor-capable browser scheme ids (must match TOR_BROWSER_IDS in browserData.ts).
  private static let knownBrowsers: [(id: String, label: String)] = [
    ("onionbrowser", "Onion Browser"),
  ]

  @objc(isSupported:rejecter:)
  func isSupported(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(false)
  }

  @objc(isAppInstalled:resolver:rejecter:)
  func isAppInstalled(_ id: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let url = URL(string: "\(id)://") else { resolve(false); return }
      resolve(UIApplication.shared.canOpenURL(url))
    }
  }

  @objc(openInApp:id:resolver:rejecter:)
  func openInApp(_ urlString: String, id: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let url = URL(string: urlString) else { resolve(false); return }
      // Onion Browser accepts a plain https URL via its own scheme handler; hand the raw URL to the OS
      // opener, which routes it to the app registered for the id's scheme when present.
      UIApplication.shared.open(url, options: [:]) { ok in resolve(ok) }
    }
  }

  @objc(listInstalledBrowsers:rejecter:)
  func listInstalledBrowsers(_ resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      var out: [[String: String]] = []
      for b in Self.knownBrowsers {
        if let url = URL(string: "\(b.id)://"), UIApplication.shared.canOpenURL(url) {
          out.append(["package": b.id, "label": b.label])
        }
      }
      resolve(out)
    }
  }

  @objc(clearBrowsingData:rejecter:)
  func clearBrowsingData(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let types = WKWebsiteDataStore.allWebsiteDataTypes()
      WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: Date(timeIntervalSince1970: 0)) {
        resolve(nil)
      }
    }
  }
}
