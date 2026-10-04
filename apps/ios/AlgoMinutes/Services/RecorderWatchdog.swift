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
        inCall: Bool = false,
        userPaused: Bool = false,
        now: Date
    ) -> Decision {
        // Paused by the user (RELEASE.md rev 11, H13): the recorder is meant to be still. Not a divergence, so
        // nothing resumes it, warns about it or gives up on it; only Resume or End does.
        guard weThinkWeAreRecording, !recorderIsRunning, !userPaused else { return .doNothing }
        // First tick of a divergence: the caller stamps `divergedSince` and the
        // grace period starts from there.
        guard let divergedSince else { return .doNothing }

        let diverged = now.timeIntervalSince(divergedSince)
        guard diverged >= graceSeconds else { return .doNothing }

        // A call holds the microphone (RELEASE.md rev 11, N1). Nothing can be captured and nothing is lost by
        // waiting, so it waits for as long as the call lasts: giving up at 300 s split one meeting into two notes.
        // It doesn't fight the call for the session either; the call's end (or the app's return) resumes it,
        // and the usual timing starts again from there.
        if inCall {
            return Decision(attemptResume: false, warnUser: !alreadyWarned, giveUp: false)
        }

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

    /// The time recorded up to `until`: what was banked, plus the live span since `startedAt` (none if paused).
    static func banked(accumulated: Int, startedAt: Date?, until: Date) -> Int {
        guard let startedAt else { return accumulated }
        return accumulated + max(0, Int(until.timeIntervalSince(startedAt)))
    }

    /// Shown while the user has paused: said plainly, as "paused" alone reads as harmless.
    static let pausedByUserNotice = "Paused. Nothing is being captured until you resume."

    /// Shown while a call holds the microphone: the recording is paused, not over.
    static let pausedForCallNotice =
        "Paused for your call. Recording carries on when the call ends; nothing is being captured until then."

    /// Shown while the recorder is not actually capturing. Deliberately concrete
    /// about the consequence — "paused" alone reads as harmless.
    static let divergedNotice =
        "Recording is paused because another app is using the microphone. "
        + "Audio is not being captured right now."
}
