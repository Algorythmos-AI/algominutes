import XCTest
@testable import AlgoMinutes

// RELEASE.md rev 11, L2 (H3): a recording's local copy stays until its kickoff is settled. A refusal the server
// answered is settled (the audio is in Storage, and Try again uses it); a request that didn't get through isn't,
// and the next launch re-sends it.
final class KickoffSettledTests: XCTestCase {
    func testTheServersRefusalsAreSettled() {
        XCTAssertTrue(AppEnvironment.kickoffWasDecided(APIError.quotaExceeded(nil)))
        XCTAssertTrue(AppEnvironment.kickoffWasDecided(APIError.updateRequired))
        XCTAssertTrue(AppEnvironment.kickoffWasDecided(APIError.http(status: 413, message: "too long")))
        XCTAssertTrue(AppEnvironment.kickoffWasDecided(APIError.http(status: 404, message: nil)))
    }

    func testWhatDidntGetThroughIsNot() {
        XCTAssertFalse(AppEnvironment.kickoffWasDecided(URLError(.notConnectedToInternet)))
        XCTAssertFalse(AppEnvironment.kickoffWasDecided(URLError(.timedOut)))
        XCTAssertFalse(AppEnvironment.kickoffWasDecided(APIError.http(status: 503, message: nil)))
        XCTAssertFalse(AppEnvironment.kickoffWasDecided(APIError.http(status: 429, message: nil)))
        XCTAssertFalse(AppEnvironment.kickoffWasDecided(APIError.http(status: 408, message: nil)))
    }
}
