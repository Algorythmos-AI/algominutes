import XCTest
@testable import AlgoMinutes

// MARK: - Back minimises and never stops (RELEASE.md rev 11, H13 / UX4)
//
// Leaving the recording screen used to end the recording. Now it carries on,
// and a bar on every tab says so and leads back.

final class RecordingMinimiseTests: XCTestCase {
    func testTheBarShowsOnlyWhileARecordingIsLiveAndItsScreenIsAway() {
        XCTAssertTrue(RecordingBar.isShown(isRecording: true, screenVisible: false))
        XCTAssertFalse(RecordingBar.isShown(isRecording: true, screenVisible: true))
        XCTAssertFalse(RecordingBar.isShown(isRecording: false, screenVisible: false))
        XCTAssertFalse(RecordingBar.isShown(isRecording: false, screenVisible: true))
    }

    func testTheBarSaysWhenTheRecordingIsPaused() {
        XCTAssertEqual(RecordingBar.title(isPaused: false), "Recording")
        XCTAssertEqual(RecordingBar.title(isPaused: true), "Recording paused")
    }
}
