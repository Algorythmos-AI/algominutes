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

    /// Without a paywall, a quota refusal doesn't send the user to one: it
    /// says when the minutes come back, or where to ask.
    func testWithoutAPaywallTheQuotaMessageSaysWhenMinutesReset() {
        let e = EntitlementResponse(state: .active, plan: "pro", billingPeriod: "2026-10", includedMinutes: 1500,
                                    usedMinutes: 1500, remainingMinutes: 0, overQuota: true, trialEndsAt: nil)
        let message = KickoffFailure.quotaMessage(e, paywallEnabled: false, locale: Locale(identifier: "en_AU"))
        XCTAssertEqual(message, "You've used this month's 1,500 included minutes. They reset on 1 November.")
        XCTAssertFalse(message.contains("Upgrade"))
        XCTAssertEqual(KickoffFailure.quotaMessage(e, paywallEnabled: true), KickoffFailure.quotaMessage)
    }

    func testWithoutAPaywallAndNoIncludedMinutesItSaysWhereToAsk() {
        let floor = EntitlementResponse(state: .freeFloor, plan: "free", billingPeriod: "2026-10", includedMinutes: 0,
                                        usedMinutes: 0, remainingMinutes: 0, overQuota: true, trialEndsAt: nil)
        for e in [floor, nil] as [EntitlementResponse?] {
            let message = KickoffFailure.quotaMessage(e, paywallEnabled: false)
            XCTAssertTrue(message.contains("Help & Support"), message)
            XCTAssertFalse(message.contains("Upgrade"))
        }
    }

    func testTheResetIsTheFirstOfTheNextMonthInUTC() {
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
        XCTAssertEqual(KickoffFailure.nextPeriodStart("2026-12"), utc.date(from: DateComponents(year: 2027, month: 1, day: 1)))
        XCTAssertNil(KickoffFailure.nextPeriodStart("2026-13"))
        XCTAssertNil(KickoffFailure.nextPeriodStart("nonsense"))
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
