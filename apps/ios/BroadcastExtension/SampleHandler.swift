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
///   The file is a fragmented MP4 (BroadcastShared/BroadcastCaptureWriter): an extension killed before it
///   finishes the file leaves it readable up to the last fragment, and the app claims it from
///   activeBroadcastFile (I3, N4).
///   unclaimedBroadcastFiles: [String] (finished captures a later broadcast found unclaimed; the app claims
///                            these first, oldest first: RELEASE.md rev 11, N4)
///   recordingSize          : Int    (bytes, set on completion)
///   lastCaptureLocation    : String (where the last capture was opened, and what each location tried gave:
///                            BroadcastCaptureWriter.open)
///   lastCaptureMove        : String (only if a capture written outside the container couldn't be moved into it)
///   errorMessage           : String? (only on error)
///   lastWriterError        : String  (compact JSON, written when the writer fails or a buffer can't be converted:
///                            BroadcastCaptureWriter.diagnostic. Counts, formats, error codes; kept until the next one)
class SampleHandler: RPBroadcastSampleHandler {

    private static let logger = Logger(subsystem: "com.algorythmos.algominutes", category: "broadcast.extension")
    private let appGroupID = "group.com.algorythmos.algominutes"

    /// The capture (BroadcastShared/BroadcastCaptureWriter): converts every buffer to one format per track and
    /// writes both tracks to one fragmented `.m4a`.
    private var capture: BroadcastCaptureWriter?
    private var lastHeartbeatTimestamp: TimeInterval = 0
    /// Refreshes the heartbeat on a clock (RELEASE.md rev 11, N4). It used to ride on the samples alone, so a
    /// quiet stretch (a muted call, a paused broadcast) looked to the app like a dead extension.
    private var heartbeatTimer: DispatchSourceTimer?
    private var startedAt: TimeInterval = 0
    /// Set once the file is being finished, so the cap and the system's own finish don't both do it.
    ///
    /// Taken under `finishLock`: ReplayKit may deliver app audio and microphone buffers on different threads, and
    /// two failed appends racing into an unguarded finish would run it twice, the second finding the file already
    /// handed over and overwriting the report with "Broadcast ended without recording any audio" (the likeliest
    /// reading of the 2026-10-29 device evidence: state "error", that message, after the append-failed alert).
    private var finishing = false
    private let finishLock = NSLock()

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

        // Two AAC tracks (app audio, microphone), configured in BroadcastShared/BroadcastCaptureWriter, in the first
        // directory of the container where the writer starts (BroadcastCaptureWriter.captureDirectories).
        // Last resort, the extension's own temporary directory: not readable by the app, so the finished file is
        // moved into the container (handOverToContainer). A kill there loses the capture; a capture beats none.
        let opened = BroadcastCaptureWriter.open(inContainer: containerURL, fileName: fileName,
                                                 fallback: FileManager.default.temporaryDirectory)
        let attempts = opened.attempts.joined(separator: " ")
        defaults?.set(attempts, forKey: "lastCaptureLocation")
        guard let capture = opened.capture, let fileURL = opened.url else {
            // Nothing can be written: say so and end the broadcast now. It used to carry on, and its first buffer's
            // append failure overwrote this reason with a generic one.
            Self.logger.error("No location in the App Group container could be written: \(attempts, privacy: .public)")
            let diagnostic = BroadcastWriterDiagnostics().json(stage: "start", writer: nil, locations: opened.attempts)
            defaults?.set(diagnostic, forKey: "lastWriterError")
            let message = "AlgoMinutes couldn't create the capture file on this iPhone. Please try again, or restart the iPhone if it keeps happening."
            recordError(message)
            finishBroadcastWithError(NSError(domain: "BroadcastExtension", code: 5, userInfo: [NSLocalizedDescriptionKey: message]))
            return
        }
        self.capture = capture
        Self.logger.info("Capturing to \(attempts, privacy: .public)")

        // An earlier capture the app hasn't claimed (finished, or left by an extension that died) is kept for it.
        let now = Date().timeIntervalSince1970
        let kept = BroadcastStartRecord.begin(path: fileURL.path, defaults: defaults, now: now)
        if !kept.isEmpty {
            Self.logger.info("Kept \(kept.count, privacy: .public) unclaimed capture(s) for the app")
        }

        startedAt = now
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 3, repeating: 3)
        timer.setEventHandler { [weak self] in
            // A tick already running when the finish cancels the timer mustn't overwrite the final stats.
            guard let self, !self.finishLock.withLock({ self.finishing }) else { return }
            self.defaults?.set(Date().timeIntervalSince1970, forKey: "lastHeartbeatAt")
            // How the capture is going (counts, levels, formats, memory), readable off the phone while it runs.
            if let stats = self.capture?.stats() { self.defaults?.set(stats, forKey: "captureStats") }
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
        let first: Bool = finishLock.withLock {
            guard !finishing else { return false }
            finishing = true
            return true
        }
        guard first else { return }
        heartbeatTimer?.cancel()
        heartbeatTimer = nil

        guard let capture, capture.sessionStarted else {
            // Never received a sample; nothing to flush.
            self.capture?.writer.cancelWriting()
            updateDefaultsOnFinish(success: false)
            then?()
            return
        }

        let dropped = capture.droppedBuffers
        if dropped > 0 {
            Self.logger.warning("Dropped \(dropped, privacy: .public) buffers (input not ready, or unconvertible)")
        }

        // A writer that failed mid-capture (a full disk, a bad append) can't be finished. The file is fragmented
        // (BroadcastCaptureWriter.fragmentInterval): what it wrote before the failure is readable, so it's handed
        // to the app, which reads what there is and reports the capture lost only if there's nothing.
        guard capture.writer.status == .writing else {
            let status = capture.writer.status.rawValue
            let reason = capture.writer.error?.localizedDescription ?? "unknown"
            Self.logger.error("Writer stopped before the finish (status \(status, privacy: .public)): \(reason, privacy: .public)")
            recordWriterDiagnostic(stage: "finish")
            handOverToContainer()
            updateDefaultsOnFinish(success: true)
            then?()
            return
        }

        // Finalize, and WAIT for it (bounded). iOS ends the extension's process soon after broadcastFinished
        // returns: the asynchronous finish this used to start never got to report, on every device run of
        // 2026-10-29 (state left "recording", no completedBroadcastFile, no process). The report is made here,
        // before returning, whether finishWriting completed or ran out of time: the file is fragmented, so what it
        // holds is readable up to its last fragment either way, and the app reports it only if nothing is.
        let done = DispatchSemaphore(value: 0)
        let completedBox = CompletionBox()
        capture.finish { completed in
            completedBox.set(completed)
            done.signal()
        }
        let timedOut = done.wait(timeout: .now() + Self.finishWait) == .timedOut
        if timedOut {
            Self.logger.error("finishWriting didn't complete within \(Self.finishWait, privacy: .public) s: handing over the fragments written")
            recordWriterDiagnostic(stage: "finish-timeout")
        } else if completedBox.value != true {
            let reason = capture.writer.error?.localizedDescription ?? "unknown"
            Self.logger.error("finishWriting did not complete, handing over the fragments written: \(reason, privacy: .public)")
            recordWriterDiagnostic(stage: "finish")
        }
        defaults?.set(capture.stats(), forKey: "captureStats")
        handOverToContainer()
        updateDefaultsOnFinish(success: true)
        then?()
    }

    /// How long the finish waits for finishWriting before reporting anyway (a short file takes well under a second).
    static let finishWait: TimeInterval = 2.5

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
        if !finishLock.withLock({ finishing }), startedAt > 0, now - startedAt >= Self.maxCaptureSeconds {
            Self.logger.info("Capture reached the cap")
            finishFile { [weak self] in
                self?.finishBroadcastWithError(NSError(domain: "BroadcastExtension", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "AlgoMinutes captures up to 4 hours. Your capture was saved, and becomes a note when you open AlgoMinutes.",
                ]))
            }
            return
        }
        guard !finishLock.withLock({ finishing }) else { return }

        guard let capture else { return }
        // The writer's session starts on the FIRST buffer of either type (in the capture), so an early stream of
        // the other type isn't dropped.
        let wasStarted = capture.sessionStarted
        // ReplayKit's thread drains no autorelease pool per buffer: whatever the writer autoreleases goes with each one.
        let appended = autoreleasepool { capture.append(sampleBuffer, to: sampleBufferType == .audioApp ? .app : .mic) }
        if !wasStarted, capture.sessionStarted {
            defaults?.set("recording", forKey: "state")
            defaults?.synchronize()
            Self.logger.info("Session started on \(sampleBufferType == .audioApp ? "app" : "mic", privacy: .public) audio")
        }
        if capture.takeConversionFailure() {
            // Not fatal (the buffer is dropped, the capture goes on), but a format ReplayKit sent that couldn't be
            // converted is what the next fix needs to know.
            Self.logger.error("A buffer couldn't be converted")
            recordWriterDiagnostic(stage: "convert")
        }
        guard appended else {
            // The writer failed (a full disk, an encoder error): nothing more can be written. End the capture with
            // what's on disk rather than keep a broadcast running that records nothing.
            let status = capture.writer.status.rawValue
            let reason = capture.writer.error?.localizedDescription ?? "unknown"
            Self.logger.error("append failed (status \(status, privacy: .public)): \(reason, privacy: .public)")
            recordWriterDiagnostic(stage: "append")
            finishFile { [weak self] in
                self?.finishBroadcastWithError(NSError(domain: "BroadcastExtension", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "The capture stopped because of an error. What was captured until then becomes a note when you open AlgoMinutes.",
                ]))
            }
            return
        }
    }

    // MARK: - Private helpers

    /// A capture written outside the App Group container (BroadcastCaptureWriter.open's last resort) is moved into
    /// it before it's reported, so the app can claim it. A move that fails is recorded and the file left where it
    /// is: the app then reports the capture as not found.
    private func handOverToContainer() {
        guard let path = defaults?.string(forKey: "activeBroadcastFile"), let container = sharedContainerURL,
              !path.hasPrefix(container.standardizedFileURL.path), !path.hasPrefix(container.path) else { return }
        let source = URL(fileURLWithPath: path)
        let candidates = BroadcastCaptureWriter.captureDirectories.map {
            $0.isEmpty ? container : container.appendingPathComponent($0, isDirectory: true)
        }
        for dir in candidates {
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let destination = dir.appendingPathComponent(source.lastPathComponent)
                try FileManager.default.moveItem(at: source, to: destination)
                defaults?.set(destination.path, forKey: "activeBroadcastFile")
                Self.logger.info("Moved the capture into the App Group container")
                return
            } catch {
                Self.logger.error("Couldn't move the capture into the App Group container: \(BroadcastWriterDiagnostics.errorChain(error).joined(separator: "<"), privacy: .public)")
                defaults?.set("move:" + BroadcastWriterDiagnostics.errorChain(error).joined(separator: "<"), forKey: "lastCaptureMove")
            }
        }
    }

    /// What the writer was doing when it failed (BroadcastCaptureWriter.diagnostic), for the app group: os_log
    /// can't be read off the phone, the group's defaults can (`devicectl device copy from`).
    private func recordWriterDiagnostic(stage: String) {
        guard let capture else { return }
        let diagnostic = capture.diagnostic(stage: stage)
        Self.logger.error("writer diagnostic: \(diagnostic, privacy: .public)")
        defaults?.set(diagnostic, forKey: "lastWriterError")
        defaults?.synchronize()
    }

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
            Self.logger.warning("Recording did not finalize (sessionStarted=\(self.capture?.sessionStarted ?? false))")
        }

        defaults?.removeObject(forKey: "activeBroadcastFile")
        defaults?.synchronize()
    }
}

/// The finish's result, set on the writer's queue and read after the wait.
private final class CompletionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var completed: Bool?
    func set(_ value: Bool) { lock.withLock { completed = value } }
    var value: Bool? { lock.withLock { completed } }
}
