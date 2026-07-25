// StiqImage.swift — iOS Tier-2 image sanitizer + pixel source. Mirrors Android StiqImageModule and
// the JS contract in src/media/mediaService.ts:
//   process(base64, maxDim)     -> { base64, mime, width, height, size, sha256, thumb{width,height,rgbaBase64} }
//   pixels(base64, maxSide)     -> { width, height, rgbaBase64 }   (whole-photo RGBA, no crop)
//   savePng(pngBase64, name)    -> Bool                            (save to Photos)
//
// Decoding to a UIImage then re-encoding to JPEG drops all EXIF/GPS/ICC metadata and normalizes the
// format — the same sanitization guarantee as Android. A non-decodable input rejects.

import Foundation
import React
import UIKit
import CryptoKit
import Photos

@objc(StiqImage)
class StiqImage: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(process:maxDim:resolver:rejecter:)
  func process(_ bytesBase64: String, maxDim: NSNumber,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let data = Data(base64Encoded: bytesBase64), let image = UIImage(data: data) else {
        reject("IMAGE_ERROR", "input is not a decodable image", nil); return
      }
      let limit = CGFloat(maxDim.intValue > 0 ? maxDim.intValue : 1280)
      let scaled = self.scaleWithin(image, maxDim: limit)
      guard let jpeg = scaled.jpegData(compressionQuality: 0.85) else {
        reject("IMAGE_ERROR", "re-encode failed", nil); return
      }
      let sha = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()

      // 32px-wide RGBA thumbnail for the JS BlurHash encoder.
      let thumb = self.scaleWithin(scaled, maxDim: 32)
      let (rgba, tw, th) = self.rgbaBytes(thumb)

      resolve([
        "base64": jpeg.base64EncodedString(),
        "mime": "image/jpeg",
        "width": Int(scaled.size.width),
        "height": Int(scaled.size.height),
        "size": jpeg.count,
        "sha256": sha,
        "thumb": ["width": tw, "height": th, "rgbaBase64": Data(rgba).base64EncodedString()],
      ])
    }
  }

  /// Decode + scale the WHOLE photo (no crop) to a width×height RGBA buffer for the pixel engine.
  @objc(pixels:maxSide:resolver:rejecter:)
  func pixels(_ base64: String, maxSide: NSNumber,
              resolver resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let data = Data(base64Encoded: base64), let image = UIImage(data: data) else {
        reject("IMAGE_ERROR", "input is not a decodable image", nil); return
      }
      let side = CGFloat(maxSide.intValue > 0 ? maxSide.intValue : 1080)
      let scaled = self.scaleWithin(image, maxDim: side)
      let (rgba, w, h) = self.rgbaBytes(scaled)
      guard w > 0, h > 0 else { reject("IMAGE_ERROR", "could not rasterize", nil); return }
      resolve(["width": w, "height": h, "rgbaBase64": Data(rgba).base64EncodedString()])
    }
  }

  /// Save a base64 PNG to the device Photos library. Resolves true on success.
  @objc(savePng:name:resolver:rejecter:)
  func savePng(_ pngBase64: String, name: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let data = Data(base64Encoded: pngBase64), let image = UIImage(data: data) else {
      reject("IMAGE_ERROR", "input is not a decodable PNG", nil); return
    }
    let addImage = {
      PHPhotoLibrary.shared().performChanges({
        PHAssetChangeRequest.creationRequestForAsset(from: image)
      }, completionHandler: { success, error in
        if success { resolve(true) }
        else { reject("IMAGE_ERROR", error?.localizedDescription ?? "save failed", nil) }
      })
    }
    // Add-only authorization (NSPhotoLibraryAddUsageDescription).
    if #available(iOS 14, *) {
      let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
      if status == .authorized || status == .limited { addImage() }
      else if status == .notDetermined {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { s in
          if s == .authorized || s == .limited { addImage() }
          else { reject("IMAGE_ERROR", "photo library add permission denied", nil) }
        }
      } else { reject("IMAGE_ERROR", "photo library add permission denied", nil) }
    } else {
      addImage()
    }
  }

  private func scaleWithin(_ image: UIImage, maxDim: CGFloat) -> UIImage {
    let w = image.size.width, h = image.size.height
    if w <= maxDim && h <= maxDim { return image }
    let ratio = maxDim / max(w, h)
    let size = CGSize(width: floor(w * ratio), height: floor(h * ratio))
    let renderer = UIGraphicsImageRenderer(size: size)
    return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
  }

  private func rgbaBytes(_ image: UIImage) -> ([UInt8], Int, Int) {
    guard let cg = image.cgImage else { return ([], 0, 0) }
    let w = cg.width, h = cg.height
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    let cs = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    ctx?.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (pixels, w, h)
  }
}
