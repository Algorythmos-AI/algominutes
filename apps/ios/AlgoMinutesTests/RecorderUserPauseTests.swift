import XCTest
@testable import AlgoMinutes

// MARK: - Pause and resume (RELEASE.md rev 11, H13)
//
// A pause the user asked for is not the divergence the watchdog exists for: the
// recorder is still on purpose. Nothing may resume it, warn about it, or end the
// recording over it, however long it lasts.

final class RecorderUserPauseTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func decide(paused: Bool, divergedFor seconds: TimeInterval, inCall: Bool = false) -> RecorderWatchdog.Decision {
        RecorderWatchdog.decide(
            weThinkWeAreRecording: true,
            recorderIsRunning: false,
            divergedSince: t0,
            lastResumeAttempt: nil,
            alreadyWarned: false,
            inCall: inCall,
            userPaused: paused,
            now: t0.addingTimeInterval(seconds)
        )
    }

    func testAUserPauseIsNeverResumedWarnedAboutOrGivenUpOn() {
        let spans: [TimeInterval] = [0, RecorderWatchdog.graceSeconds, RecorderWatchdog.warnAfterSeconds, RecorderWatchdog.giveUpSeconds, 4 * 3600]
        for seconds in spans {
            XCTAssertEqual(decide(paused: true, divergedFor: seconds), .doNothing, "\(seconds)s")
            XCTAssertEqual(decide(paused: true, divergedFor: seconds, inCall: true), .doNothing, "\(seconds)s, in a call")
        }
    }

    func testWithoutAPauseTheSameStillnessIsStillADivergence() {
        // The control: the same inputs, not paused, are acted on.
        XCTAssertTrue(decide(paused: false, divergedFor: RecorderWatchdog.graceSeconds).attemptResume)
        XCTAssertTrue(decide(paused: false, divergedFor: RecorderWatchdog.giveUpSeconds).giveUp)
    }

    func testPausedTimeIsNotCountedTowardsTheRecording() {
        // Banked at the pause: 10 minutes recorded, then any length of pause, is still 10 minutes.
        let banked = RecorderWatchdog.banked(accumulated: 0, startedAt: t0, until: t0.addingTimeInterval(600))
        XCTAssertEqual(banked, 600)
        XCTAssertEqual(RecorderWatchdog.banked(accumulated: banked, startedAt: nil, until: t0.addingTimeInterval(9_000)), 600)
    }

    func testThePauseNoticeSaysNothingIsBeingCaptured() {
        XCTAssertTrue(RecorderWatchdog.pausedByUserNotice.contains("Nothing is being captured"))
    }
}
