import AVFoundation
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
    private let api: APIClient
    private var player: AVPlayer?
    private var timeObserver: Any?
    private var itemObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    /// The note a streamed (signed-URL) source came from, to ask for a fresh
    /// link when the old one expires (RELEASE.md rev 11, H17).
    private var remoteNote: (noteId: String, workspaceId: String)?
    /// When the link was last replaced: at most one refresh a minute, so a
    /// recording that really can't play doesn't loop.
    private var lastRefreshAt: Date?

    init(session: AudioSessionCoordinator, store: RecordingStore, api: APIClient) {
        self.api = api
        self.session = session
        self.store = store
    }

    // MARK: - Loading

    func load(note: Note) async {
        // The same note again is a no-op, unless its playback failed: then it's
        // loaded afresh (a new link). It used to stay failed until another note
        // was opened.
        guard currentNoteId != note.id || error != nil else { return }
        stop()
        remoteNote = nil

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
        case .remote:
            isLoading = true
            defer { isLoading = false }
            do {
                // The api checks membership and signs a 15-minute GET for the
                // note's own object (the recordings bucket isn't readable directly).
                let url = try await api.noteAudioURL(noteId: note.id, workspaceId: note.workspaceId)
                sizeBytes = nil
                attach(url: url, noteId: note.id)
                remoteNote = (note.id, note.workspaceId)
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
                guard let self else { return }
                // A streamed recording's link lasts 15 minutes. Past that, a seek
                // or a resume fails: ask for a new link and carry on where it was.
                if await self.refreshRemoteLink() { return }
                self.error = .playbackFailed
                self.isPlaying = false
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

    /// A fresh signed link for the streamed note, resuming at the same place
    /// and in the same state. False when there's nothing to refresh, it was
    /// refreshed less than a minute ago, or the api refused.
    private func refreshRemoteLink() async -> Bool {
        guard let source = remoteNote else { return false }
        if let last = lastRefreshAt, Date().timeIntervalSince(last) < 60 { return false }
        lastRefreshAt = Date()
        let resumeAt = currentTime
        let wasPlaying = isPlaying
        do {
            let url = try await api.noteAudioURL(noteId: source.noteId, workspaceId: source.workspaceId)
            stop()
            attach(url: url, noteId: source.noteId)
            remoteNote = source
            seek(to: resumeAt)
            if wasPlaying { play() }
            AppLog.info("audio_link_refreshed")
            return true
        } catch {
            AppLog.error("audio_link_refresh_failed: \(error)")
            return false
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
