import Foundation

/// Decides what to do when we think we are recording but the recorder is not.
///
/// The failure this exists for: `AVAudioSession` posts `.began` when a phone
/// call arrives and `.ended` when it finishes, and the recorder resumed *only*
/// in the `.ended` branch. If `.ended` never arrived — a long call, the app
/// suspended, the system deciding not to tell us — the recorder stayed paused
/// forever while the screen still read "Recording in progress". The user
/// finished a recording believing it was captured. Nothing detected it,
/// because nothing ever compared what we believed against what the recorder was
/// actually doing.
///
/// Pure and `Date`-injected so every branch is testable without AVFoundation.
enum RecorderWatchdog {
    struct Decision: Equatable {
        var attemptResume = false
        var warnUser = false
        var giveUp = false

        static let doNothing = Decision()
    }

    /// Divergence is normal for a moment during any interruption, so a Siri
    /// blip must not trip anything.
    static let graceSeconds: TimeInterval = 3
    /// Resuming hammers `setActive(true)`, which fails while another app holds
    /// the session. Spacing the attempts keeps that cheap.
    static let resumeRetrySeconds: TimeInterval = 5
    /// Tell the user early. This is the whole point: while diverged, nothing
    /// is being captured, and every second they don't know is a second of
    /// recording they think is recorded and isn't.
    static let warnAfterSeconds: TimeInterval = 20
    /// Give up late. Stopping does not preserve any audio that waiting would
    /// lose — nothing is being captured either way — so the only thing an early
    /// stop buys is forcing the recording into two notes when the call ends. Five
    /// minutes is past the point where the recording is likely still wanted.
    static let giveUpSeconds: TimeInterval = 300

    static func decide(
        weThinkWeAreRecording: Bool,
        recorderIsRunning: Bool,
        divergedSince: Date?,
        lastResumeAttempt: Date?,
        alreadyWarned: Bool,
        now: Date
    ) -> Decision {
        guard weThinkWeAreRecording, !recorderIsRunning else { return .doNothing }
        // First tick of a divergence: the caller stamps `divergedSince` and the
        // grace period starts from there.
        guard let divergedSince else { return .doNothing }

        let diverged = now.timeIntervalSince(divergedSince)
        guard diverged >= graceSeconds else { return .doNothing }

        if diverged >= giveUpSeconds {
            return Decision(attemptResume: false, warnUser: false, giveUp: true)
        }

        var decision = Decision()
        decision.warnUser = !alreadyWarned && diverged >= warnAfterSeconds
        if let lastResumeAttempt {
            decision.attemptResume = now.timeIntervalSince(lastResumeAttempt) >= resumeRetrySeconds
        } else {
            decision.attemptResume = true
        }
        return decision
    }

    /// Shown while the recorder is not actually capturing. Deliberately concrete
    /// about the consequence — "paused" alone reads as harmless.
    static let divergedNotice =
        "Recording is paused because another app is using the microphone. "
        + "Audio is not being captured right now."
}
