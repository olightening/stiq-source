//
//  StiqFiles.swift — iOS counterpart of Android's StiqFilesModule.kt.
//
//  JS contract (client/src/util/fileExport.ts):
//      saveTextFile(name, mime, content) -> Promise<String>   (resolves the saved file name)
//
//  Android writes the bytes silently into the device's PUBLIC Downloads collection. iOS has no
//  such shared, app-writable Downloads folder, and STIQ is privacy-focused — persisting exports
//  into an exposed app directory (UIFileSharingEnabled) would leak the whole Documents tree. So
//  iOS instead writes the bytes to a throwaway temp file and hands it to the system share sheet
//  (UIActivityViewController): a `.ics` routes straight to Calendar ("Add to Calendar"), a `.csv`
//  guest list to Files / Mail / AirDrop. The temp file is removed the moment the sheet closes.
//
//  Contract match: resolve the sanitized file name once the user COMPLETES an activity (so the JS
//  layer flips "✓ Added" only on a real save); reject when the sheet is dismissed without saving or
//  anything fails. The JS wrapper (fileExport.ts) treats every rejection as a clean `false`, so a
//  cancel simply leaves the UI in its pre-export state — never a false success, never a throw.
//

import Foundation
import React
import UIKit

@objc(StiqFiles)
class StiqFiles: NSObject {

  // Presents UIKit; initialize on the main queue like the other UI-touching module (StiqWebProxy).
  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc(saveTextFile:mime:content:resolver:rejecter:)
  func saveTextFile(_ name: String, mime: String, content: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Defense in depth: the JS layer already sanitizes, but never let a path separator or control
    // byte reach the filesystem regardless of what crosses the bridge (mirrors the Kotlin guard).
    let safeName = Self.sanitize(name)
    guard let data = content.data(using: .utf8) else {
      reject("SAVE_ERROR", "content is not encodable as UTF-8", nil)
      return
    }

    // A per-call temp subdirectory so identically-named exports never collide; removed on close.
    let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("stiq-export-\(UUID().uuidString)", isDirectory: true)
    let fileURL = dir.appendingPathComponent(safeName)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try data.write(to: fileURL, options: .atomic)
    } catch {
      reject("SAVE_ERROR", error.localizedDescription, nil)
      return
    }
    let cleanup = { try? FileManager.default.removeItem(at: dir) }

    DispatchQueue.main.async {
      guard let presenter = Self.topViewController() else {
        cleanup()
        reject("SAVE_ERROR", "no view controller available to present the share sheet", nil)
        return
      }

      let sheet = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
      // On iPad a share sheet is a popover and MUST have an anchor or -present throws. Anchor to the
      // centre of the presenting view with no arrow (a neutral, always-valid source rect).
      if let pop = sheet.popoverPresentationController {
        pop.sourceView = presenter.view
        pop.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY,
                                width: 0, height: 0)
        pop.permittedArrowDirections = []
      }

      var settled = false
      sheet.completionWithItemsHandler = { _, completed, _, activityError in
        cleanup()
        if settled { return }
        settled = true
        if let err = activityError {
          reject("SAVE_ERROR", err.localizedDescription, nil)
        } else if completed {
          resolve(safeName)
        } else {
          // Dismissed without choosing an activity — nothing was saved.
          reject("SAVE_CANCELLED", "share sheet dismissed without saving", nil)
        }
      }
      presenter.present(sheet, animated: true)
    }
  }

  /// Strip C0/DEL control bytes and cross-filesystem-reserved path characters; fall back to a
  /// non-empty default. Mirrors StiqFilesModule.kt's `safeName` regex and fileExport.ts's
  /// sanitizeFileName. Iterating unicode scalars is grapheme-safe: Swift recomposes adjacent
  /// scalars (e.g. a ZWJ emoji in an event title) back into one cluster as they are appended.
  private static func sanitize(_ name: String) -> String {
    let reserved = CharacterSet(charactersIn: "/\\:*?\"<>|")
    var out = ""
    for scalar in name.unicodeScalars {
      if scalar.value < 0x20 || scalar.value == 0x7f || reserved.contains(scalar) {
        out.append("_")
      } else {
        out.append(Character(scalar))
      }
    }
    let trimmed = out.trimmingCharacters(in: .whitespaces)
    return trimmed.isEmpty ? "stiq-export.txt" : trimmed
  }

  /// The top-most presented view controller, so the sheet appears above the RN `<Modal>` that the
  /// Events detail / organizer screens present (they are their own view controllers on iOS).
  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes
    let scene = (scenes.first { $0.activationState == .foregroundActive } as? UIWindowScene)
      ?? (scenes.first as? UIWindowScene)
    let window = scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}
