import AVFoundation
import Foundation

/// Claims a capture the ReplayKit broadcast extension finished (another app's
/// audio plus the microphone, BroadcastExtension/SampleHandler), so it becomes
/// a note like any recording.
///
/// The extension writes into the App Group container and reports through the
/// group's UserDefaults (`state`, `completedBroadcastFile`, `lastHeartbeatAt`,
/// `errorMessage`). Its `.m4a` keeps the app audio and the microphone on two
/// tracks, but the transcoder hears one (ffmpeg takes a single stream), so the
/// app mixes them into one track before upload. The mixed file lives in the
/// RecordingStore directory, where the usual upload and recovery apply.
@MainActor
final class BroadcastHandoff {
    static let appGroupID = "group.com.algorythmos.algominutes"
    /// The extension refreshes its heartbeat every ~3 s while capturing. Silent
    /// for this long, it was killed (its memory limit, a crash).
    static let staleHeartbeat: TimeInterval = 30

    enum Pickup: Equatable {
        case none
        case ready(fileURL: URL, durationSeconds: Int)
        case failed(message: String)
    }

    enum HandoffError: Error { case noAudio, exportFailed }

    private let defaults: UserDefaults?
    private let store: RecordingStore
    private let now: () -> Date

    init(
        store: RecordingStore,
        defaults: UserDefaults? = UserDefaults(suiteName: BroadcastHandoff.appGroupID),
        now: @escaping () -> Date = Date.init
    ) {
        self.store = store
        self.defaults = defaults
        self.now = now
    }

    /// Captures that finished before a later broadcast started, and weren't claimed in between (RELEASE.md
    /// rev 11, N4). The extension lists them (`unclaimedBroadcastFiles`) instead of dropping their pointer,
    /// which used to orphan the file and lose the meeting. Claimed first, oldest first.
    static let unclaimedKey = "unclaimedBroadcastFiles"

    private var unclaimed: [String] { defaults?.stringArray(forKey: Self.unclaimedKey) ?? [] }

    /// Take the oldest unclaimed capture off the list, if there is one.
    private func takeUnclaimed() -> String? {
        var list = unclaimed
        guard !list.isEmpty else { return nil }
        let first = list.removeFirst()
        if list.isEmpty { defaults?.removeObject(forKey: Self.unclaimedKey) } else { defaults?.set(list, forKey: Self.unclaimedKey) }
        return first
    }

    /// The latest capture finished and waits to be claimed.
    private var hasLatestFinished: Bool {
        defaults?.string(forKey: "state") == "finished" && defaults?.string(forKey: "completedBroadcastFile") != nil
    }

    /// A finished capture is waiting to be claimed: the latest, or an earlier one a later broadcast kept.
    var hasFinishedCapture: Bool { !unclaimed.isEmpty || hasLatestFinished }

    /// Throws away a finished capture without making a note (the user declined
    /// to confirm they had permission to record it). One at a time, the same one `claim()` would take.
    func discardFinished() {
        guard let d = defaults, hasFinishedCapture else { return }
        if let earlier = takeUnclaimed() {
            try? FileManager.default.removeItem(atPath: earlier)
            AppLog.info("broadcast_discarded earlier=true")
            return
        }
        if let path = d.string(forKey: "completedBroadcastFile") {
            try? FileManager.default.removeItem(atPath: path)
        }
        d.removeObject(forKey: "completedBroadcastFile")
        d.set("claimed", forKey: "state")
        AppLog.info("broadcast_discarded")
    }

    /// What to do with a finished capture when the app comes back.
    enum ClaimDecision: Equatable {
        /// Nothing finished waits: claim anyway, which reports a capture that
        /// failed or whose extension died.
        case claim
        /// The server's kill switch is off: leave the capture where it is,
        /// untouched, until the switch is back. Say so once.
        case hold
        /// A capture started from Control Center, with no pre-recording
        /// notice acknowledged this session: ask before uploading it.
        case askConsent
    }

    /// The broadcast extension can be started from Control Center, outside the
    /// app's consent step and whatever the kill switch says. Nothing it
    /// captured is uploaded without both.
    nonisolated static func decide(hasFinishedCapture: Bool, switchOn: Bool, consented: Bool) -> ClaimDecision {
        guard hasFinishedCapture else { return .claim }
        if !switchOn { return .hold }
        return consented ? .claim : .askConsent
    }

    /// The extension is capturing right now (and alive).
    var isCapturing: Bool {
        defaults?.bool(forKey: "isBroadcasting") == true && !heartbeatStale
    }

    private var heartbeatStale: Bool {
        let last = defaults?.double(forKey: "lastHeartbeatAt") ?? 0
        return now().timeIntervalSince1970 - last > Self.staleHeartbeat
    }

    /// Takes a finished capture, once: a second call (the app coming to the
    /// foreground twice) finds nothing. Also reports a capture that failed or
    /// whose extension died, and clears it.
    func claim() async -> Pickup {
        guard let d = defaults else { return .none }
        // An earlier capture a later broadcast kept: taken off the list before any work, so no other call
        // picks it up meanwhile. The latest capture's own state is left as it is, for the next call.
        if let earlier = takeUnclaimed() {
            AppLog.info("broadcast_claiming_earlier remaining=\(unclaimed.count)")
            return await pickUp(path: earlier)
        }
        switch d.string(forKey: "state") {
        case "finished":
            guard let path = d.string(forKey: "completedBroadcastFile") else { return .none }
            // Claimed before any work, so no other call picks it up meanwhile.
            d.removeObject(forKey: "completedBroadcastFile")
            d.set("claimed", forKey: "state")
            return await pickUp(path: path)
        case "error":
            let message = d.string(forKey: "errorMessage") ?? "The capture didn't record any audio."
            d.set("claimed", forKey: "state")
            d.removeObject(forKey: "errorMessage")
            return .failed(message: message)
        default:
            // The extension said it was capturing, then went silent: killed before
            // it could finish the file, which is unreadable without its index.
            if d.bool(forKey: "isBroadcasting"), heartbeatStale {
                if let path = d.string(forKey: "activeBroadcastFile") {
                    try? FileManager.default.removeItem(atPath: path)
                }
                d.set(false, forKey: "isBroadcasting")
                d.set("claimed", forKey: "state")
                d.removeObject(forKey: "activeBroadcastFile")
                AppLog.error("broadcast_extension_died")
                return .failed(message: "The capture stopped unexpectedly and couldn't be saved.")
            }
            return .none
        }
    }

    /// A finished capture at `path`, mixed into the recording store.
    private func pickUp(path: String) async -> Pickup {
        let source = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: source.path) else {
            AppLog.error("broadcast_file_missing")
            return .failed(message: "The captured audio couldn't be found.")
        }
        let destination = store.makeRecordingURL(ext: "m4a")
        do {
            let seconds = try await Self.mixDown(source: source, destination: destination)
            try? FileManager.default.removeItem(at: source)
            AppLog.info("broadcast_claimed seconds=\(seconds)")
            return .ready(fileURL: destination, durationSeconds: seconds)
        } catch {
            // Keep the capture rather than lose it: move it as recorded (one
            // track may go untranscribed, which beats no note at all).
            AppLog.error("broadcast_mix_failed: \(error.localizedDescription)")
            do {
                try FileManager.default.moveItem(at: source, to: destination)
                let seconds = Int((try? await AVURLAsset(url: destination).load(.duration).seconds) ?? 0)
                return .ready(fileURL: destination, durationSeconds: seconds)
            } catch {
                AppLog.error("broadcast_move_failed: \(error.localizedDescription)")
                return .failed(message: "The captured audio couldn't be saved.")
            }
        }
    }

    /// Every audio track of `source` (app audio, microphone) mixed into one
    /// track of AAC `.m4a` at `destination`. Returns the length in seconds.
    nonisolated static func mixDown(source: URL, destination: URL) async throws -> Int {
        let asset = AVURLAsset(url: source)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard !tracks.isEmpty else { throw HandoffError.noAudio }
        let duration = try await asset.load(.duration)
        let composition = AVMutableComposition()
        for track in tracks {
            let added = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            try added?.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: track, at: .zero)
        }
        // An audio-only preset writes one track: the export mixes every input track.
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
            throw HandoffError.exportFailed
        }
        try? FileManager.default.removeItem(at: destination)
        if #available(iOS 18, *) {
            try await export.export(to: destination, as: .m4a)
        } else {
            export.outputURL = destination
            export.outputFileType = .m4a
            await export.export()
            guard export.status == .completed else { throw export.error ?? HandoffError.exportFailed }
        }
        return Int(duration.seconds.rounded())
    }
}
