import ReplayKit
import AVFoundation
import os

/// ReplayKit Broadcast Upload Extension.
///
/// Captures BOTH `audioApp` (system audio from the meeting app) and `audioMic`
/// (the user's microphone) into separate AAC tracks in a single .m4a written
/// to the App Group container, where the main app reads it after the user
/// stops the broadcast.
///
/// The state machine surface (UserDefaults keys, suite `group.com.wassup.meeting`):
///   state                  : "starting" | "recording" | "finished" | "error"
///   isBroadcasting         : Bool   (true while extension is alive)
///   startedAt              : Double (UNIX seconds, set in broadcastStarted)
///   lastHeartbeatAt        : Double (UNIX seconds, refreshed every ~3s in processSampleBuffer)
///   activeBroadcastFile    : String (full path while recording)
///   completedBroadcastFile : String (set in finishWriting completion)
///   recordingSize          : Int    (bytes, set on completion)
///   errorMessage           : String? (only on error)
class SampleHandler: RPBroadcastSampleHandler {

    private static let logger = Logger(subsystem: "com.wassup.meeting", category: "broadcast.extension")
    private let appGroupID = "group.com.wassup.meeting"

    private var writer: AVAssetWriter?
    private var appAudioInput: AVAssetWriterInput?
    private var micAudioInput: AVAssetWriterInput?
    private var sessionStarted = false
    private var lastHeartbeatTimestamp: TimeInterval = 0

    private var sharedContainerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
    }

    private var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupID)
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        Self.logger.info("broadcastStarted")

        guard let containerURL = sharedContainerURL else {
            recordError("App Group container not available")
            finishBroadcastWithError(NSError(
                domain: "BroadcastExtension", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "App Group container not available"]
            ))
            return
        }

        // UUID-based filename avoids collisions with prior runs and avoids
        // race conditions if main app is reading an older completed file.
        let fileName = "broadcast_\(UUID().uuidString).m4a"
        let fileURL = containerURL.appendingPathComponent(fileName)

        do {
            writer = try AVAssetWriter(outputURL: fileURL, fileType: .m4a)
        } catch {
            Self.logger.error("Failed to create AVAssetWriter: \(error.localizedDescription, privacy: .public)")
            recordError("Failed to create recording file")
            finishBroadcastWithError(error as NSError)
            return
        }

        // Two separate audio tracks. Each AVAssetWriterInput maintains its own
        // monotonic timeline; mixing app+mic into ONE input causes PTS regressions
        // and produces an unplayable file.
        //
        // Output settings: AAC, 44.1kHz, mono, 64kbps. Source format may differ
        // (app audio is typically 48kHz stereo, mic is 16kHz mono) — AVAssetWriterInput
        // converts on append.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
        ]

        let appInput = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        appInput.expectsMediaDataInRealTime = true
        if writer?.canAdd(appInput) == true {
            writer?.add(appInput)
            appAudioInput = appInput
        }

        let micInput = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        micInput.expectsMediaDataInRealTime = true
        if writer?.canAdd(micInput) == true {
            writer?.add(micInput)
            micAudioInput = micInput
        }

        guard writer?.startWriting() == true else {
            let err = writer?.error?.localizedDescription ?? "unknown"
            Self.logger.error("startWriting failed: \(err, privacy: .public)")
            recordError("Could not begin recording: \(err)")
            return
        }

        let now = Date().timeIntervalSince1970
        defaults?.set("starting", forKey: "state")
        defaults?.set(true, forKey: "isBroadcasting")
        defaults?.set(now, forKey: "startedAt")
        defaults?.set(now, forKey: "lastHeartbeatAt")
        defaults?.set(fileURL.path, forKey: "activeBroadcastFile")
        defaults?.removeObject(forKey: "completedBroadcastFile")
        defaults?.removeObject(forKey: "errorMessage")
        defaults?.removeObject(forKey: "recordingSize")
        defaults?.synchronize()
    }

    override func broadcastPaused() {
        Self.logger.info("broadcastPaused")
    }

    override func broadcastResumed() {
        Self.logger.info("broadcastResumed")
    }

    override func broadcastFinished() {
        Self.logger.info("broadcastFinished")

        guard sessionStarted else {
            // Never received a sample; nothing to flush.
            writer?.cancelWriting()
            updateDefaultsOnFinish(success: false)
            return
        }

        appAudioInput?.markAsFinished()
        micAudioInput?.markAsFinished()

        // Async finalize. iOS gives extension ~3s to clean up after broadcastFinished
        // returns; AVAssetWriter.finishWriting completes well within that for short
        // files. NO blocking semaphore — that risks force-kill before completion.
        writer?.finishWriting { [weak self] in
            self?.updateDefaultsOnFinish(success: true)
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Capture both system audio AND mic. Video is intentionally ignored.
        guard sampleBufferType == .audioApp || sampleBufferType == .audioMic else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        // Heartbeat throttled to once per ~3s. Used by main app to detect a dead
        // extension — if heartbeat is stale > 15s while state==recording, the
        // extension was killed (OOM, crash, etc.) and the recording is interrupted.
        let now = Date().timeIntervalSince1970
        if now - lastHeartbeatTimestamp > 3 {
            defaults?.set(now, forKey: "lastHeartbeatAt")
            lastHeartbeatTimestamp = now
        }

        // Start the writer session on the FIRST buffer of any accepted type.
        // If we waited for a specific type, an early stream of the other type
        // would be silently dropped.
        if !sessionStarted {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer?.startSession(atSourceTime: pts)
            sessionStarted = true
            defaults?.set("recording", forKey: "state")
            defaults?.synchronize()
            Self.logger.info("Session started, first PTS=\(pts.seconds, privacy: .public)")
        }

        let input = (sampleBufferType == .audioApp) ? appAudioInput : micAudioInput
        if input?.isReadyForMoreMediaData == true {
            input?.append(sampleBuffer)
        }
    }

    // MARK: - Private helpers

    private func recordError(_ message: String) {
        Self.logger.error("recordError: \(message, privacy: .public)")
        defaults?.set("error", forKey: "state")
        defaults?.set(message, forKey: "errorMessage")
        defaults?.set(false, forKey: "isBroadcasting")
        defaults?.synchronize()
    }

    private func updateDefaultsOnFinish(success: Bool) {
        defaults?.set(false, forKey: "isBroadcasting")

        if success, let path = defaults?.string(forKey: "activeBroadcastFile") {
            defaults?.set(path, forKey: "completedBroadcastFile")
            defaults?.set("finished", forKey: "state")
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let size = attrs[.size] as? Int {
                defaults?.set(size, forKey: "recordingSize")
            }
            Self.logger.info("Recording finalized successfully")
        } else {
            // Either we never got a sample (sessionStarted=false) or write failed.
            // Don't promote to "finished" — main app will treat as no recording.
            if defaults?.string(forKey: "state") != "error" {
                defaults?.set("error", forKey: "state")
                defaults?.set("Broadcast ended without recording any audio", forKey: "errorMessage")
            }
            Self.logger.warning("Recording did not finalize (sessionStarted=\(self.sessionStarted))")
        }

        defaults?.removeObject(forKey: "activeBroadcastFile")
        defaults?.synchronize()
    }
}
