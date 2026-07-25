// StiqAudio.swift — NIP-A0 voice messages. JS contract in src/media/voiceRecorder.ts + feed/voice.ts:
//   requestMicPermission() -> Bool
//   startRecording()       -> void
//   stopRecording()        -> { base64, mime, durationSec, size }
//   cancelRecording()      -> void
//   playBase64(base64)     -> void
//   stopPlayback()         -> void
//   importAudio()          -> { base64, mime, durationSec, size } | null   (system file picker)
//
// Records AAC/m4a (44100 Hz, mono) — the same family as Android's MediaRecorder — and carries the
// clip INLINE as base64 (no media host). requestMicPermission + category activation are the same
// AVAudioSession singleton, so mic permission lives here (not a separate module).

import Foundation
import React
import AVFoundation
import UIKit
import UniformTypeIdentifiers

@objc(StiqAudio)
class StiqAudio: NSObject, AVAudioPlayerDelegate, UIDocumentPickerDelegate {

  private var recorder: AVAudioRecorder?
  private var player: AVAudioPlayer?
  private var recordURL: URL?
  private var recordStart: Date?
  private var importResolve: RCTPromiseResolveBlock?
  private var importReject: RCTPromiseRejectBlock?

  @objc static func requiresMainQueueSetup() -> Bool { true } // file picker presentation is main-thread

  private func session() -> AVAudioSession { AVAudioSession.sharedInstance() }

  @objc(requestMicPermission:rejecter:)
  func requestMicPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    // The single AVAudioSession record-permission prompt. Fixes the iOS voiceRecorder hole where JS
    // returned "granted" without ever asking.
    session().requestRecordPermission { granted in resolve(granted) }
  }

  @objc(startRecording:rejecter:)
  func startRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    do {
      try session().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
      try session().setActive(true)
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("stiq-voice-\(ProcessInfo.processInfo.globallyUniqueString).m4a")
      let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
      ]
      let rec = try AVAudioRecorder(url: url, settings: settings)
      rec.prepareToRecord()
      guard rec.record() else { reject("AUDIO_ERROR", "recorder failed to start", nil); return }
      recorder = rec
      recordURL = url
      recordStart = Date()
      resolve(nil)
    } catch {
      reject("AUDIO_ERROR", error.localizedDescription, nil)
    }
  }

  @objc(stopRecording:rejecter:)
  func stopRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let rec = recorder, let url = recordURL else {
      reject("AUDIO_ERROR", "not recording", nil); return
    }
    let duration = rec.currentTime > 0 ? rec.currentTime : Date().timeIntervalSince(recordStart ?? Date())
    rec.stop()
    recorder = nil
    recordURL = nil
    recordStart = nil
    try? session().setActive(false, options: [.notifyOthersOnDeactivation])
    do {
      let data = try Data(contentsOf: url)
      try? FileManager.default.removeItem(at: url)
      resolve([
        "base64": data.base64EncodedString(),
        "mime": "audio/mp4",
        "durationSec": duration,
        "size": data.count,
      ])
    } catch {
      reject("AUDIO_ERROR", "could not read recorded clip: \(error.localizedDescription)", nil)
    }
  }

  @objc(cancelRecording:rejecter:)
  func cancelRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    recorder?.stop()
    if let url = recordURL { try? FileManager.default.removeItem(at: url) }
    recorder = nil
    recordURL = nil
    recordStart = nil
    try? session().setActive(false, options: [.notifyOthersOnDeactivation])
    resolve(nil)
  }

  @objc(playBase64:resolver:rejecter:)
  func playBase64(_ base64: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let data = Data(base64Encoded: base64) else {
      reject("AUDIO_ERROR", "clip is not valid base64", nil); return
    }
    do {
      try session().setCategory(.playback, mode: .default)
      try session().setActive(true)
      let p = try AVAudioPlayer(data: data)
      p.delegate = self
      guard p.play() else { reject("AUDIO_ERROR", "player failed to start", nil); return }
      player = p
      resolve(nil)
    } catch {
      reject("AUDIO_ERROR", error.localizedDescription, nil)
    }
  }

  @objc(stopPlayback:rejecter:)
  func stopPlayback(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    player?.stop()
    player = nil
    try? session().setActive(false, options: [.notifyOthersOnDeactivation])
    resolve(nil)
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    self.player = nil
    try? session().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  // ── Import an audio file via the system picker ───────────────────────────────────────────────

  @objc(importAudio:rejecter:)
  func importAudio(_ resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      if self.importResolve != nil { reject("AUDIO_ERROR", "an import is already in progress", nil); return }
      self.importResolve = resolve
      self.importReject = reject
      let picker: UIDocumentPickerViewController
      if #available(iOS 14, *) {
        picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.audio], asCopy: true)
      } else {
        picker = UIDocumentPickerViewController(documentTypes: ["public.audio"], in: .import)
      }
      picker.delegate = self
      picker.allowsMultipleSelection = false
      guard let root = Self.topViewController() else {
        self.settleImport(nil, error: "no view controller to present the file picker"); return
      }
      root.present(picker, animated: true)
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first else { settleImport(nil, error: nil); return }
    let needsStop = url.startAccessingSecurityScopedResource()
    defer { if needsStop { url.stopAccessingSecurityScopedResource() } }
    do {
      let data = try Data(contentsOf: url)
      var duration: Double = 0
      if let p = try? AVAudioPlayer(data: data) { duration = p.duration }
      settleImport([
        "base64": data.base64EncodedString(),
        "mime": Self.mime(for: url),
        "durationSec": duration,
        "size": data.count,
      ], error: nil)
    } catch {
      settleImport(nil, error: "could not read the picked file: \(error.localizedDescription)")
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    settleImport(nil, error: nil) // cancel resolves null per contract
  }

  private func settleImport(_ value: Any?, error: String?) {
    let resolve = importResolve
    let reject = importReject
    importResolve = nil
    importReject = nil
    if let e = error { reject?("AUDIO_ERROR", e, nil) }
    else { resolve?(value) } // value nil ⇒ resolve(null) ⇒ "cancelled"
  }

  private static func mime(for url: URL) -> String {
    switch url.pathExtension.lowercased() {
    case "m4a", "mp4", "aac": return "audio/mp4"
    case "mp3": return "audio/mpeg"
    case "wav": return "audio/wav"
    case "ogg", "opus": return "audio/ogg"
    default: return "audio/mp4"
    }
  }

  private static func topViewController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
    var top = (scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}
