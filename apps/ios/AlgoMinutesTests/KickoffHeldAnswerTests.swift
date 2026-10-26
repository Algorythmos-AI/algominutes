import XCTest
@testable import AlgoMinutes

// MARK: - A kickoff held for minutes (RELEASE.md rev 11, H6c)

final class KickoffHeldAnswerTests: XCTestCase {
    func testAHeldAnswerIsRecognised() {
        XCTAssertTrue(APIClient.kickoffWasHeld(["success": true, "noteId": "n1", "status": NSNull(), "inFlight": true, "held": true]))
    }

    func testQueuedAndInFlightAnswersAreNotHeld() {
        XCTAssertFalse(APIClient.kickoffWasHeld(["success": true, "noteId": "n1", "jobId": "j", "status": "queued"]))
        XCTAssertFalse(APIClient.kickoffWasHeld(["success": true, "noteId": "n1", "status": "transcribing", "inFlight": true]))
        XCTAssertFalse(APIClient.kickoffWasHeld([:]))
    }
}
