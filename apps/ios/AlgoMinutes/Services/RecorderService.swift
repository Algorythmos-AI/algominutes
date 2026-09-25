import AVFoundation
import Foundation
import UIKit

/// Native port of `BackgroundRecorderPlugin.swift` — AAC in ADTS (.aac, see
/// `RecordingFormat`: a killed recording stays decodable), 44.1 kHz mono 64 kbps
/// constant bitrate, background-audio capable, interruption auto-resume,
/// orphan-file recovery. Adds live metering for the waveform and elapsed-time
/// tracking.
@Observable
@MainActor
final class RecorderService: NSObject, AVAudioRecorderDelegate {
    // Per-recording cap — plan-derived config (A6.2). Mirrors
    // DEFAULT_MAX_RECORDING_SECONDS in @algominutes/contracts (the single source);
    // Swift can't import the TS const, so it is duplicated here with a TODO to
    // read the signed-in user's plan cap once entitlements land (A9).
    // A full 4-hour recording at 64 kbps is ~115 MB (ADTS adds ~5% of frame
    // headers), well under the api's 500 MB upload cap. Warn 5 minutes before cap.
    // TODO(A9): source this from the user's plan entitlement, not a constant.
    static let maxRecordingSeconds = 4 * 60 * 60
    static let warnAfterSeconds = maxRecordingSeconds - 300

    private(set) var isRecording = false
    private(set) var elapsedSeconds = 0
    /// Normalized 0...1 mic level for the waveform.
    private(set) var level: Float = 0
    /// Set only when the file itself is unusable (encode error / unsuccessful
    /// finish) — the UI discards the recording in this case.
    var recordingError: String?
    /// A stop the service performed on its own — hard cap reached, un-resumable
    /// interruption, lost input route. Distinct from `recordingError`, which
    /// means the file itself is unusable.
    ///
    /// This used to be `autoStopRequested: Bool`, a *request* that only
    /// `RecordingView` could carry out. SwiftUI does not evaluate `body` for a
    /// backgrounded scene, so the `.onChange` that performed the stop could not
    /// be relied on to fire — and if the recording screen had been torn down
    /// there was no consumer at all. A recording that hit the 2-hour cap in a
    /// pocket therefore kept writing, and past ~120 MB the storage rules reject
    /// the upload permanently, so the recording became unrecoverable.
    ///
    /// It is now an accomplished fact: the recorder has already stopped and the
    /// file is already finalised by the time anyone observes this.
    private(set) var autoStopped: AutoStop?

    struct AutoStop: Equatable, Identifiable {
        enum Reason: Equatable {
            case hardCap
            case interruptionNotResumable
            case sessionReactivationFailed
            case routeRecoveryFailed
        }

        let reason: Reason
        /// `nil` when there was nothing worth keeping.
        let result: StopResult?
        let at: Date

        var id: Date { at }

        /// What the user is told. Each case names what happened, because
        /// "recording stopped" alone leaves them guessing whether it was them.
        var message: String {
            let kept = result != nil
                ? "We've kept what was recorded — save it on the next screen."
                : "No audio had been captured yet."
            switch reason {
            case .hardCap:
                return "Recording reached the \(RecorderService.maxRecordingSeconds / 3600)-hour limit and stopped. \(kept)"
            case .interruptionNotResumable:
                return "Recording stopped because another app took over the microphone. \(kept)"
            case .sessionReactivationFailed:
                return "Recording stopped after an interruption and couldn't resume. \(kept)"
            case .routeRecoveryFailed:
                return "Recording stopped because the microphone became unavailable. \(kept)"
            }
        }
    }
    /// Transient, user-visible status (e.g. "switched to built-in microphone").
    var notice: String?

    private var recorder: AVAudioRecorder?
    private(set) var currentFileURL: URL?
    private var recordingFailed = false
    private var tickTimer: Timer?
    private var startedAt: Date?
    private var accumulatedSeconds = 0

    // Watchdog state: when our belief and the recorder's reality parted company,
    // when we last tried to fix it, and whether the user has been told.
    private var divergedSince: Date?
    private var lastResumeAttempt: Date?
    private var hasWarnedAboutDivergence = false

    private let store: RecordingStore

    /// A10 §5 SEAM: the consent decision evaluated before capture starts. v1.0's
    /// gate is satisfied iff the per-session pre-recording notice was
    /// acknowledged; the jurisdiction-aware §4 layer plugs in here later without
    /// touching `start()`. See `docs/CONSENT.md`.
    let consentGate: ConsentGate

    // consentGate defaults to a fresh SessionConsentGate. It is constructed in
    // the (MainActor-isolated) init body rather than as a default argument
    // because Swift 5.10 evaluates default-argument expressions in a nonisolated
    // context, where calling the @MainActor SessionConsentGate() init is illegal.
    init(store: RecordingStore, consentGate: ConsentGate? = nil) {
        self.store = store
        self.consentGate = consentGate ?? SessionConsentGate()
        super.init()
    }

    private var session: AVAudioSession { AVAudioSession.sharedInstance() }

    // MARK: - Permission

    func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    // MARK: - Start / stop

    enum RecorderError: LocalizedError {
        case permissionDenied
        case alreadyRecording
        case consentNotSatisfied
        case sessionFailed(String)
        case startFailed(String)
        case insufficientStorage(freeMB: Int)

        var errorDescription: String? {
            switch self {
            case .permissionDenied:
                return "Microphone permission is required to record audio. Please enable it in Settings."
            case .alreadyRecording:
                return "A recording is already in progress"
            case .consentNotSatisfied:
                return "Please acknowledge the recording notice before you start."
            case .sessionFailed(let m):
                return "Failed to configure audio session: \(m)"
            case .startFailed(let m):
                return "Failed to start recording: \(m)"
            case .insufficientStorage(let freeMB):
                return "Not enough space to record. About \(freeMB) MB free, and a "
                     + "two-hour recording needs around 60 MB. Free up space and try again."
            }
        }
    }

    /// A 4-hour recording is ~120 MB at 64 kbps mono AAC (ADTS). Refuse below about
    /// double that, leaving headroom for the OS so a recording cannot fill the disk.
    static let minFreeBytesToRecord: Int64 = 250 * 1024 * 1024

    /// Free space on the volume holding the recordings directory.
    ///
    /// nonisolated because it touches no actor state — just the filesystem —
    /// which also lets it be exercised from a synchronous test.
    nonisolated static func freeDiskBytes(at url: URL) -> Int64? {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    func start() async throws {
        guard recorder == nil else { throw RecorderError.alreadyRecording }
        guard await requestPermission() else { throw RecorderError.permissionDenied }

        // SEAM (A10 §4, docs/CONSENT.md §5): the jurisdiction-aware consent
        // layer plugs in here. v1.0 ships a gate whose only implementation is
        // "the per-session consent checkbox in RecorderConsentFlow was ticked".
        // §4 replaces the gate's body; this call site does not change. One gate,
        // all paths — no capture path may start without passing it.
        guard await consentGate.satisfied(for: .microphone) else {
            throw RecorderError.consentNotSatisfied
        }

        // Refuse up front rather than fail at minute 55. AVAudioRecorder's
        // encode error arrives partway through, and before the salvage path
        // existed it took the whole recording with it. Telling someone now
        // costs them nothing; discovering it mid-recording costs the recording.
        if let free = Self.freeDiskBytes(at: store.directory), free < Self.minFreeBytesToRecord {
            let freeMB = Int(free / (1024 * 1024))
            AppLog.error("recording_refused_low_disk freeMB=\(freeMB)")
            throw RecorderError.insufficientStorage(freeMB: freeMB)
        }

        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            throw RecorderError.sessionFailed(error.localizedDescription)
        }

        // Recordings persist in Application Support and are only removed after a
        // confirmed upload — never destroy a pending one when a new session
        // starts. Recovery of unfinished recordings is handled by RecordingStore.
        let fileURL = store.makeRecordingURL()

        // The .aac URL makes the recorder write ADTS (RecordingFormat). Constant
        // bitrate keeps seeking by time accurate, since ADTS has no index.
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            AVEncoderBitRateKey: 64_000,
            AVEncoderBitRateStrategyKey: AVAudioBitRateStrategy_Constant,
        ]

        do {
            let recorder = try AVAudioRecorder(url: fileURL, settings: settings)
            recorder.delegate = self
            recorder.isMeteringEnabled = true
            recorder.record()
            self.recorder = recorder
            currentFileURL = fileURL
            recordingFailed = false
            recordingError = nil
            autoStopped = nil
            notice = nil
            elapsedSeconds = 0
            accumulatedSeconds = 0
            // Without this a divergence left over from the previous recording
            // trips the watchdog on the first tick of the next one.
            divergedSince = nil
            lastResumeAttempt = nil
            hasWarnedAboutDivergence = false
            startedAt = Date()
            isRecording = true

            addObservers()
            startTicking()
            AppLog.info("recording_started path=\(fileURL.lastPathComponent)")
        } catch {
            currentFileURL = nil
            throw RecorderError.startFailed(error.localizedDescription)
        }
    }

    /// `Identifiable` so it can drive a `.sheet(item:)` — the naming sheet
    /// presents on a finished recording rather than on a separate boolean,
    /// which keeps the two impossible to desynchronise.
    struct StopResult: Identifiable, Equatable {
        var id: URL { fileURL }
        var fileURL: URL
        var sizeBytes: Int64
        var durationSeconds: Int
        var recordingFailed: Bool
    }

    /// Accepts both actively-recording AND paused (interrupted) recorders —
    /// a paused recorder still holds a valid partial file.
    func stop() -> StopResult? {
        guard let recorder else { return nil }
        recorder.stop()
        self.recorder = nil
        stopTicking()
        isRecording = false

        removeObservers()
        do {
            try session.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            AppLog.error("audio_session_deactivate_failed: \(error.localizedDescription)")
        }

        guard let url = currentFileURL else { return nil }
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? Int64) ?? 0
        let duration = elapsedSeconds
        AppLog.info("recording_stopped size=\(size) duration=\(duration)s")
        return StopResult(fileURL: url, sizeBytes: size, durationSeconds: duration, recordingFailed: recordingFailed)
    }

    /// Finalise whatever was captured after an encode failure, if anything.
    ///
    /// AVAudioRecorder writes AAC progressively, so a file that failed partway
    /// — the phone filling up mid-recording being the realistic case — is still
    /// decodable up to the failure point. Discarding it threw away everything
    /// recorded before the problem; a user 55 minutes into a recording lost
    /// all 55 minutes.
    ///
    /// Returns nil only when there is genuinely nothing to keep, which is the
    /// caller's signal that deleting is the right move after all.
    ///
    /// MIN_SALVAGE_BYTES rather than `> 0`: an AAC container always has header
    /// bytes, so a non-zero size does not mean audio was captured.
    func salvageCurrentFile() -> StopResult? {
        guard let url = currentFileURL else { return nil }
        // Stop cleanly if still running, so the moov atom is written and the
        // file is playable rather than a truncated stream.
        if recorder != nil { _ = stop() }
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? Int64) ?? 0
        guard size >= Self.minSalvageBytes else {
            AppLog.info("recording_salvage_too_small size=\(size)")
            return nil
        }
        AppLog.info("recording_salvaged size=\(size) duration=\(elapsedSeconds)s")
        return StopResult(
            fileURL: url, sizeBytes: size,
            durationSeconds: elapsedSeconds, recordingFailed: true,
        )
    }

    /// Roughly a second of 64 kbps mono AAC. Below this there is no meaningful
    /// audio, only container overhead.
    static let minSalvageBytes: Int64 = 8_000

    /// Discards the current unassociated recording (mic error / no audio
    /// captured, before any note exists). Never call this once a note has been
    /// created and the file associated — the durable copy must survive.
    func deleteCurrentFile() {
        if let url = currentFileURL {
            store.remove(fileURL: url)
        }
        currentFileURL = nil
    }

    // MARK: - Timer + metering

    private func startTicking() {
        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func stopTicking() {
        tickTimer?.invalidate()
        tickTimer = nil
        level = 0
    }

    private func tick() {
        guard let recorder else { return }
        elapsedSeconds = computeElapsed()
        recorder.updateMeters()
        let db = recorder.averagePower(forChannel: 0) // -160...0 dB
        level = max(0, min(1, (db + 50) / 50))
        enforceHardCap()
        runWatchdog()
    }

    /// Compare what we believe against what the recorder is doing, and act.
    ///
    /// Lives in `tick()` rather than on its own timer: the app holds an active
    /// audio session under `UIBackgroundModes: audio`, so the runloop keeps
    /// running — and therefore this keeps firing — while backgrounded, which is
    /// exactly when the failure it catches happens.
    private func runWatchdog(now: Date = Date()) {
        guard isRecording, autoStopped == nil else { return }

        if recorder?.isRecording == true {
            // Recovered (or never diverged). Clear the state so the next
            // divergence starts its own grace period.
            if divergedSince != nil {
                AppLog.info("recording_divergence_resolved")
                divergedSince = nil
                lastResumeAttempt = nil
                hasWarnedAboutDivergence = false
                if notice == RecorderWatchdog.divergedNotice { notice = nil }
            }
            return
        }

        if divergedSince == nil {
            divergedSince = now
            AppLog.info("recording_diverged elapsed=\(elapsedSeconds)s")
        }

        let decision = RecorderWatchdog.decide(
            weThinkWeAreRecording: isRecording,
            recorderIsRunning: false,
            divergedSince: divergedSince,
            lastResumeAttempt: lastResumeAttempt,
            alreadyWarned: hasWarnedAboutDivergence,
            now: now
        )

        if decision.warnUser {
            hasWarnedAboutDivergence = true
            notice = RecorderWatchdog.divergedNotice
            AppLog.info("recording_divergence_warned")
        }
        if decision.attemptResume {
            lastResumeAttempt = now
            attemptResume()
        }
        if decision.giveUp {
            AppLog.error("recording_divergence_unrecoverable")
            autoStop(reason: .sessionReactivationFailed)
        }
    }

    /// Try to get the recorder running again. Returns nothing because the
    /// watchdog re-checks on the next tick rather than trusting this call —
    /// `record()` can return true and still not take.
    @discardableResult
    private func attemptResume() -> Bool {
        do {
            // The session must be reactivated before `record()` or the recorder
            // silently captures nothing while the timer keeps running.
            try session.setActive(true)
        } catch {
            AppLog.info("recording_resume_session_failed: \(error.localizedDescription)")
            return false
        }
        // `record()`'s return value was previously discarded in both resume
        // paths, so a refused resume looked identical to a successful one.
        guard recorder?.record() == true, recorder?.isRecording == true else {
            AppLog.info("recording_resume_refused")
            return false
        }
        // Restart elapsed-time accounting, which also re-arms the hard cap —
        // `computeElapsed()` is frozen while `startedAt` is nil.
        startedAt = Date()
        AppLog.info("recording_resumed_by_watchdog")
        return true
    }

    /// Wall-clock elapsed time, independent of how often the UI timer fires
    /// (the timer is a display convenience only). `accumulatedSeconds` banks
    /// time across interruptions; `startedAt` measures the current live span.
    private func computeElapsed(now: Date = Date()) -> Int {
        guard let startedAt else { return accumulatedSeconds }
        return accumulatedSeconds + Int(now.timeIntervalSince(startedAt))
    }

    /// Enforces the recording cap on wall-clock time. Because a `Timer` may not
    /// tick while backgrounded, this is also re-checked on interruption end and
    /// on foregrounding so a long background recording still stops (and uploads
    /// the partial) rather than blowing past the size cap.
    private func enforceHardCap() {
        guard isRecording, autoStopped == nil else { return }
        if computeElapsed() >= Self.maxRecordingSeconds {
            elapsedSeconds = computeElapsed()
            AppLog.info("recording_hard_cap_reached elapsed=\(elapsedSeconds)s")
            autoStop(reason: .hardCap)
        }
    }

    /// Stop the recording ourselves and finalise the file.
    ///
    /// The service must do this rather than ask a view to, because every
    /// situation that triggers it — a 2-hour meeting, a phone call, a
    /// disconnected mic — is one where the app is plausibly backgrounded and no
    /// view is being evaluated.
    private func autoStop(reason: AutoStop.Reason) {
        guard autoStopped == nil else { return }
        // stop() accepts a paused recorder, which is exactly the state an
        // interruption leaves us in, and returns nil only when there is no
        // recorder at all. Fall back to salvage so a file that exists but did
        // not stop cleanly is still kept.
        let result = stop() ?? salvageCurrentFile()
        AppLog.info("recording_auto_stopped reason=\(reason) kept=\(result != nil)")
        let event = AutoStop(reason: reason, result: result, at: Date())
        autoStopped = event
        // Every reason this fires is one where the phone is plausibly in a
        // pocket. Without this the sheet is raised behind a locked screen and
        // the user learns their recording ended when they next open the app.
        RecordingNotifier.recordingStopped(message: event.message)
    }

    // MARK: - Observers

    private func addObservers() {
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(handleAudioInterruption),
            name: AVAudioSession.interruptionNotification, object: session
        )
        center.addObserver(
            self, selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification, object: session
        )
        center.addObserver(
            self, selector: #selector(handleWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(handleWillTerminate),
            name: UIApplication.willTerminateNotification, object: nil
        )
    }

    private func removeObservers() {
        NotificationCenter.default.removeObserver(self)
    }

    /// Finalise the file when the app is being terminated.
    ///
    /// Synchronous on purpose. Termination gives single-digit seconds and there
    /// is no guarantee a `Task { @MainActor in ... }` hop is ever scheduled, so
    /// the `AVAudioRecorder.stop()` that writes the moov atom has to happen
    /// right here. With the old `.m4a` format a force-quit left a file with no
    /// sample tables: unplayable and unrepairable. Recordings are now ADTS
    /// (`RecordingFormat`), which stays decodable without this; stopping still
    /// flushes the last buffered frames.
    ///
    /// `assumeIsolated` is sound: `willTerminate` is delivered on the main
    /// thread. It is not delivered at all on a crash or a jetsam, and ADTS is
    /// what makes that case lose only the last partial frame.
    @objc private nonisolated func handleWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            guard self.isRecording, let recorder = self.recorder else { return }
            recorder.stop()
            AppLog.info("recording_finalized_on_terminate elapsed=\(self.computeElapsed())s")
        }
    }

    @objc private nonisolated func handleWillEnterForeground(_ notification: Notification) {
        // Re-sync the wall-clock display and re-check the cap; a timer that was
        // starved while backgrounded may have missed the cap boundary.
        Task { @MainActor in
            guard self.isRecording else { return }
            self.elapsedSeconds = self.computeElapsed()
            self.enforceHardCap()
            // Resolve a divergence immediately on return to the app rather than
            // waiting for the next tick — this is the moment the user is
            // looking at the screen and would otherwise see a frozen timer.
            self.runWatchdog()
        }
    }

    // MARK: - AVAudioRecorderDelegate

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard !flag else { return }
        Task { @MainActor in
            self.recordingFailed = true
            self.recordingError = "Recording finished unsuccessfully. The audio file may be incomplete or corrupt."
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let message = error?.localizedDescription ?? "Unknown encoding error"
        Task { @MainActor in
            self.recordingFailed = true
            self.recordingError = "Recording failed: \(message)"
            self.recorder?.stop()
            self.recorder = nil
            self.isRecording = false
            self.stopTicking()
            self.removeObservers()
            try? self.session.setActive(false, options: .notifyOthersOnDeactivation)
            // The realistic cause is the device filling up mid-recording, which
            // gives no other signal while backgrounded.
            RecordingNotifier.recordingStopped(
                message: "Recording stopped unexpectedly. Open AlgoMinutes to save what was recorded."
            )
        }
    }

    // MARK: - Interruptions (phone call, Siri)

    @objc private nonisolated func handleAudioInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }
        let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt

        Task { @MainActor in
            switch type {
            case .began:
                AppLog.info("recording_interrupted")
                // Pause elapsed-time accounting while interrupted.
                if let startedAt = self.startedAt {
                    self.accumulatedSeconds += Int(Date().timeIntervalSince(startedAt))
                    self.startedAt = nil
                }
            case .ended:
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue ?? 0)
                guard options.contains(.shouldResume) else {
                    // System won't auto-resume — stop and keep the partial rather
                    // than discard it.
                    AppLog.info("recording_not_resumable")
                    self.autoStop(reason: .interruptionNotResumable)
                    return
                }
                // Do not auto-stop if this fails. A refused resume is exactly
                // what the watchdog is for: it keeps retrying and gives the
                // system time to hand the microphone back, which a phone call
                // ending routinely does a moment after `.ended` arrives.
                if self.attemptResume() {
                    AppLog.info("recording_resumed")
                    self.enforceHardCap()
                } else {
                    AppLog.info("recording_resume_deferred_to_watchdog")
                }
            @unknown default:
                break
            }
        }
    }

    // MARK: - Route changes (Bluetooth / wired mic unplugged)

    @objc private nonisolated func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        // Only `.oldDeviceUnavailable` (the input we were using went away, e.g.
        // AirPods/wired mic disconnected) risks capturing silence. Other reasons
        // (new device available, category change) are benign.
        guard reason == .oldDeviceUnavailable else { return }

        Task { @MainActor in
            guard self.isRecording else { return }
            AppLog.info("recording_route_lost")
            do {
                // Keep recording on the built-in mic rather than silently dying.
                try self.session.setActive(true)
                if self.recorder?.isRecording == false {
                    // Checked, unlike before: a refused record() used to look
                    // exactly like a successful one, so a dead recorder kept
                    // the reassuring "recording continues" notice on screen.
                    guard self.attemptResume() else {
                        self.notice = RecorderWatchdog.divergedNotice
                        return
                    }
                }
                self.notice = "Input device changed — recording continues on the built-in microphone."
            } catch {
                AppLog.error("recording_route_recover_failed: \(error.localizedDescription)")
                self.autoStop(reason: .routeRecoveryFailed)
            }
        }
    }
}
