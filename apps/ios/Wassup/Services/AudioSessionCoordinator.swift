import AVFoundation

/// Arbitrates the one shared `AVAudioSession` between recording and playback.
///
/// Two things want the session and they want it configured differently:
/// `RecorderService` sets `.playAndRecord` and deactivates on stop, while the
/// note player wants `.playback` with `.spokenAudio`. Without an arbiter the
/// last writer wins, and the failure mode is the bad one — a recording that
/// silently captures nothing because playback reconfigured the session under
/// it.
///
/// **The recorder always wins.** Losing playback is an inconvenience; losing a
/// clinical recording is unrecoverable, because the moment has passed.
@Observable
@MainActor
final class AudioSessionCoordinator {
    enum Owner: Equatable { case none, player, recorder }

    private(set) var owner: Owner = .none

    private var session: AVAudioSession { .sharedInstance() }

    /// Claim the session for playback. Refused while the recorder holds it —
    /// the caller surfaces that inline rather than as an error.
    func acquireForPlayback() throws {
        guard owner != .recorder else { throw AudioSessionError.recorderActive }
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        owner = .player
    }

    /// Hand the session to the recorder, tearing down playback first.
    ///
    /// Called *before* `RecorderService.start()` so the category change lands
    /// on an already-idle session; reconfiguring underneath a playing
    /// AVPlayer is what produces the "records silence" class of bug.
    func yieldToRecorder(stopPlayback: () -> Void) {
        if owner == .player { stopPlayback() }
        owner = .recorder
    }

    /// The recorder has stopped and already deactivated the session.
    func recorderFinished() {
        if owner == .recorder { owner = .none }
    }

    /// Playback finished or was torn down.
    func releasePlayback() {
        guard owner == .player else { return }
        owner = .none
        // Deactivating lets whatever was playing before Wassup resume, which
        // is the behaviour a user expects from a note player.
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }
}

enum AudioSessionError: Error, Equatable {
    case recorderActive
}
