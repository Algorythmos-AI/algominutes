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
/// The state machine surface (UserDefaults keys, suite `group.com.algorythmos.algominutes`):
///   state                  : "starting" | "recording" | "finished" | "error"
///   isBroadcasting         : Bool   (true while extension is alive)
///   startedAt              : Double (UNIX seconds, set in broadcastStarted)
///   lastHeartbeatAt        : Double (UNIX seconds, refreshed every ~3s in processSampleBuffer)
///   activeBroadcastFile    : String (full path while recording)
///   completedBroadcastFile : String (set in finishWriting completion)
///   unclaimedBroadcastFiles: [String] (finished captures a later broadcast found unclaimed; the app claims
///                            these first, oldest first: RELEASE.md rev 11, N4)
///   recordingSize          : Int    (bytes, set on completion)
///   errorMessage           : String? (only on error)
class SampleHandler: RPBroadcastSampleHandler {

    private static let logger = Logger(subsystem: "com.algorythmos.algominutes", category: "broadcast.extension")
    private let appGroupID = "group.com.algorythmos.algominutes"

    private var writer: AVAssetWriter?
    private var appAudioInput: AVAssetWriterInput?
    private var micAudioInput: AVAssetWriterInput?
    private var sessionStarted = false
    private var lastHeartbeatTimestamp: TimeInterval = 0
    /// Refreshes the heartbeat on a clock (RELEASE.md rev 11, N4). It used to ride on the samples alone, so a
    /// quiet stretch (a muted call, a paused broadcast) looked to the app like a dead extension.
    private var heartbeatTimer: DispatchSourceTimer?
    private var startedAt: TimeInterval = 0
    /// Set once the file is being finished, so the cap and the system's own finish don't both do it.
    private var finishing = false

    /// The longest capture, as a recording's (4 hours).
    static let maxCaptureSeconds: TimeInterval = 4 * 60 * 60
    /// Room for a full-length capture: two 64 kbps tracks for 4 hours is about 230 MB.
    static let minFreeBytesToCapture: Int64 = 300 * 1024 * 1024

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

        // Refuse now rather than fail hours in: an .m4a cut off by a full disk has no index and can't be read.
        if let free = (try? containerURL.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage, free < Self.minFreeBytesToCapture {
            let message = "There isn't enough free storage on this iPhone to capture a call. Free up some space and try again."
            recordError(message)
            finishBroadcastWithError(NSError(domain: "BroadcastExtension", code: 2, userInfo: [NSLocalizedDescriptionKey: message]))
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
        // A capture that finished and hasn't been claimed yet (the app wasn't opened in between) is kept: it
        // joins the list the app claims from. Clearing its pointer here orphaned the file, and the meeting.
        if defaults?.string(forKey: "state") == "finished", let waiting = defaults?.string(forKey: "completedBroadcastFile") {
            var unclaimed = defaults?.stringArray(forKey: "unclaimedBroadcastFiles") ?? []
            if !unclaimed.contains(waiting) { unclaimed.append(waiting) }
            defaults?.set(unclaimed, forKey: "unclaimedBroadcastFiles")
            Self.logger.info("Kept an unclaimed capture for the app (\(unclaimed.count, privacy: .public) waiting)")
        }
        defaults?.removeObject(forKey: "completedBroadcastFile")
        defaults?.removeObject(forKey: "errorMessage")
        defaults?.removeObject(forKey: "recordingSize")
        defaults?.synchronize()

        startedAt = now
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 3, repeating: 3)
        timer.setEventHandler { [weak self] in
            self?.defaults?.set(Date().timeIntervalSince1970, forKey: "lastHeartbeatAt")
        }
        timer.resume()
        heartbeatTimer = timer
    }

    override func broadcastPaused() {
        Self.logger.info("broadcastPaused")
    }

    override func broadcastResumed() {
        Self.logger.info("broadcastResumed")
    }

    override func broadcastFinished() {
        Self.logger.info("broadcastFinished")
        finishFile(then: nil)
    }

    /// Finish the file and report it, once. `then` runs after the report (the cap ends the broadcast there).
    private func finishFile(then: (() -> Void)?) {
        guard !finishing else { return }
        finishing = true
        heartbeatTimer?.cancel()
        heartbeatTimer = nil

        guard sessionStarted else {
            // Never received a sample; nothing to flush.
            writer?.cancelWriting()
            updateDefaultsOnFinish(success: false)
            then?()
            return
        }

        appAudioInput?.markAsFinished()
        micAudioInput?.markAsFinished()

        // Async finalize. iOS gives extension ~3s to clean up after broadcastFinished
        // returns; AVAssetWriter.finishWriting completes well within that for short
        // files. NO blocking semaphore — that risks force-kill before completion.
        writer?.finishWriting { [weak self] in
            guard let self else { return }
            // The completion runs whether or not the file was written: a failed writer (a full disk, a bad
            // append) used to be reported as a finished capture, and the app then found a file it couldn't read.
            let completed = self.writer?.status == .completed
            if !completed {
                let reason = self.writer?.error?.localizedDescription ?? "unknown"
                Self.logger.error("finishWriting did not complete: \(reason, privacy: .public)")
                self.recordError("The capture couldn't be saved.")
            }
            self.updateDefaultsOnFinish(success: completed)
            then?()
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

        // The same cap as a recording. The file is finished and reported first, then the broadcast is ended
        // with the reason: iOS shows it, and the app makes the note when it's next opened.
        if !finishing, startedAt > 0, now - startedAt >= Self.maxCaptureSeconds {
            Self.logger.info("Capture reached the cap")
            finishFile { [weak self] in
                self?.finishBroadcastWithError(NSError(domain: "BroadcastExtension", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "AlgoMinutes captures up to 4 hours. Your capture was saved, and becomes a note when you open AlgoMinutes.",
                ]))
            }
            return
        }
        guard !finishing else { return }

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
