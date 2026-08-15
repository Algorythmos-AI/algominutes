import AVFoundation
import FirebaseStorage
import MediaPlayer
import Observation

/// Plays a note's audio.
///
/// Lives on `AppEnvironment` rather than in the note screen so playback
/// survives popping the detail view, switching tabs, and backgrounding —
/// which is the point of a player rather than a preview.
///
/// Streams; it does not download. `AVURLAsset` range-requests, so seeking into
/// a two-hour recording is immediate and there is no upfront wait. It also
/// means no audio cache on disk, which keeps `NSPrivacyAccessedAPICategoryDiskSpace`
/// out of the privacy manifest.
@Observable
@MainActor
final class AudioPlayerService {
    enum PlaybackError: Equatable {
        case unavailable          // note has no audio
        case recorderActive       // session held by a recording
        case loadFailed           // could not resolve or open the asset
        case playbackFailed       // AVPlayer reported an item error

        var message: String {
            switch self {
            case .unavailable: return "This note has no audio."
            case .recorderActive: return "Stop recording to play this note."
            case .loadFailed: return "Couldn't load this recording."
            case .playbackFailed: return "Playback stopped unexpectedly."
            }
        }
    }

    private(set) var currentNoteId: String?
    private(set) var isPlaying = false
    private(set) var isLoading = false
    /// True when the player has stalled waiting for data — rendered as a
    /// shimmering scrubber rather than an indefinite spinner.
    private(set) var isStalled = false
    private(set) var currentTime: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    private(set) var speed: PlaybackSpeed = .normal
    private(set) var error: PlaybackError?
    /// Byte size from Storage metadata — the note document has no size field,
    /// so this is where the header's meta line gets one.
    private(set) var sizeBytes: Int64?

    private let session: AudioSessionCoordinator
    private let store: RecordingStore
    private var player: AVPlayer?
    private var timeObserver: Any?
    private var itemObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?

    init(session: AudioSessionCoordinator, store: RecordingStore) {
        self.session = session
        self.store = store
    }

    // MARK: - Loading

    func load(note: Note) async {
        guard currentNoteId != note.id else { return }
        stop()

        let local = store.pendingRecording(forNoteId: note.id).map { store.audioURL(for: $0) }
        let existingLocal = local.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
        let source = AudioAssetResolver.decide(
            localFileURL: existingLocal, storagePath: note.storagePath, type: note.type
        )

        switch source {
        case .none:
            error = .unavailable
        case .local(let url):
            sizeBytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? nil
            attach(url: url, noteId: note.id)
        case .remote(let path):
            isLoading = true
            defer { isLoading = false }
            do {
                let ref = Storage.storage().reference(withPath: path)
                // Metadata and URL in one round trip each; the size is wanted
                // for the header regardless of whether playback starts.
                async let metadata = ref.getMetadata()
                async let url = ref.downloadURL()
                sizeBytes = try await metadata.size
                attach(url: try await url, noteId: note.id)
            } catch {
                AppLog.error("audio_resolve_failed: \(error)")
                self.error = .loadFailed
            }
        }
    }

    private func attach(url: URL, noteId: String) {
        let item = AVPlayerItem(asset: AVURLAsset(url: url))
        let player = AVPlayer(playerItem: item)
        // Pitch-corrected time stretching tuned for voice, so 1.5x and 2x stay
        // intelligible instead of sounding chipmunked. (.spokenAudio is the
        // audio *session* mode, set by AudioSessionCoordinator — a different
        // API with a confusingly similar name.)
        player.currentItem?.audioTimePitchAlgorithm = .timeDomain
        self.player = player
        currentNoteId = noteId
        error = nil

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.currentTime = time.seconds
                if let d = self.player?.currentItem?.duration.seconds, d.isFinite, d > 0 {
                    self.duration = d
                }
                self.isStalled = self.isPlaying
                    && player.timeControlStatus == .waitingToPlayAtSpecifiedRate
            }
        }

        itemObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            Task { @MainActor [weak self] in
                AppLog.error("audio_item_failed: \(String(describing: item.error))")
                self?.error = .playbackFailed
                self?.isPlaying = false
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.isPlaying = false
                self?.seek(to: 0)
                self?.updateNowPlaying()
            }
        }
    }

    // MARK: - Transport

    func togglePlayPause() {
        isPlaying ? pause() : play()
    }

    func play() {
        guard let player else { return }
        do {
            try session.acquireForPlayback()
        } catch {
            self.error = .recorderActive
            return
        }
        self.error = nil
        player.rate = Float(speed.rawValue)
        isPlaying = true
        configureRemoteCommands()
        updateNowPlaying()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        updateNowPlaying()
    }

    func skip(_ seconds: TimeInterval) {
        seek(to: max(0, min(duration, currentTime + seconds)))
    }

    func seek(to time: TimeInterval) {
        guard let player else { return }
        let clamped = max(0, min(duration > 0 ? duration : time, time))
        player.seek(to: CMTime(seconds: clamped, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero)
        currentTime = clamped
        updateNowPlaying()
    }

    func cycleSpeed() {
        speed = speed.next()
        // `rate` doubles as play/pause, so only push it while actually playing.
        if isPlaying { player?.rate = Float(speed.rawValue) }
        updateNowPlaying()
    }

    /// Called before a recording starts. The recorder owns the session from
    /// here; playback tears down rather than fighting for it.
    func suspendForRecording() {
        stop()
    }

    func stop() {
        player?.pause()
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        itemObservation?.invalidate()
        itemObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player = nil
        currentNoteId = nil
        isPlaying = false
        isStalled = false
        currentTime = 0
        duration = 0
        sizeBytes = nil
        clearNowPlaying()
        session.releasePlayback()
    }

    // MARK: - Lock screen
    //
    // Not optional. An app that declares UIBackgroundModes: audio and then
    // shows a dead lock screen is both a bad experience and something App
    // Review reasonably objects to.

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.skipForwardCommand.removeTarget(nil)
        center.skipBackwardCommand.removeTarget(nil)
        center.changePlaybackPositionCommand.removeTarget(nil)

        center.skipForwardCommand.preferredIntervals = [5]
        center.skipBackwardCommand.preferredIntervals = [5]

        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.play() }; return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }; return .success
        }
        center.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.skip(5) }; return .success
        }
        center.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.skip(-5) }; return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.seek(to: e.positionTime) }
            return .success
        }
    }

    private func updateNowPlaying() {
        guard currentNoteId != nil else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: nowPlayingTitle,
            MPMediaItemPropertyArtist: "AlgoMinutes",
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? speed.rawValue : 0,
        ]
    }

    private func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPRemoteCommandCenter.shared().playCommand.removeTarget(nil)
        MPRemoteCommandCenter.shared().pauseCommand.removeTarget(nil)
    }

    /// Set by the screen so the lock screen shows the note's name.
    var nowPlayingTitle: String = "Recording" {
        didSet { updateNowPlaying() }
    }
}
