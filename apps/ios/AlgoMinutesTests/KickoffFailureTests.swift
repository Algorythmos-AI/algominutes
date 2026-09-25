import XCTest
@testable import AlgoMinutes

/// Each /v1/process refusal maps to one thing the app does
/// (services/api/src/routes/process-intelligence.js).
final class KickoffFailureTests: XCTestCase {
    private let fallback = "Could not start processing. Please try again."

    func testQuotaOpensThePaywallAndMarksTheNote() {
        let failure = KickoffFailure(APIError.quotaExceeded(nil), fallback: fallback)
        guard case .quota = failure else { return XCTFail("\(failure)") }
        XCTAssertEqual(failure.noteError, KickoffFailure.quotaMessage)
    }

    func testAnOutdatedAppAsksForTheUpdate() {
        let failure = KickoffFailure(APIError.updateRequired, fallback: fallback)
        guard case .updateRequired = failure else { return XCTFail("\(failure)") }
        XCTAssertEqual(failure.noteError, KickoffFailure.updateMessage)
    }

    /// The server marked the note failed itself (Postgres first): the client
    /// shows its message and doesn't overwrite the note.
    func testTooLargeAndRateLimitedKeepTheServersMessage() {
        for status in [413, 429] {
            let failure = KickoffFailure(APIError.http(status: status, message: "server says"), fallback: fallback)
            XCTAssertEqual(failure.message, "server says")
            XCTAssertNil(failure.noteError, "\(status)")
        }
        XCTAssertEqual(KickoffFailure(APIError.http(status: 429, message: nil), fallback: fallback).message, fallback)
    }

    func testGoneAndEverythingElseMarkTheNote() {
        let gone = KickoffFailure(APIError.http(status: 404, message: "Audio not found"), fallback: fallback)
        XCTAssertEqual(gone.noteError, KickoffFailure.notFoundMessage)
        for error: Error in [APIError.http(status: 500, message: "x"), URLError(.notConnectedToInternet), APIError.invalidResponse] {
            XCTAssertEqual(KickoffFailure(error, fallback: fallback).noteError, fallback)
        }
    }
}
