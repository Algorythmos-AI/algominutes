import XCTest
@testable import AlgoMinutes

/// The beta's invite codes (docs/plans/RELEASE.md PR 8): with the paywall off,
/// a tester with no minutes is asked for their code before recording, a quota
/// hit opens the code sheet (not a silent no-op), and a redeemed code becomes
/// the entitlement.
@MainActor
final class InviteCodeTests: XCTestCase {
    private func api() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    private func entitlement(remaining: Double?, state: EntitlementState = .freeFloor) -> EntitlementResponse {
        EntitlementResponse(state: state, plan: "free", billingPeriod: "2026-10", includedMinutes: remaining == nil ? nil : 0,
                            usedMinutes: 0, remainingMinutes: remaining, overQuota: remaining == 0, trialEndsAt: nil)
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.recorded = []
        StubURLProtocol.responder = { _ in (200, Data("{}".utf8)) }
    }

    func testWithoutAPaywallNoMinutesAsksForTheCodeBeforeRecording() {
        let billing = BillingService(api: api(), paywallEnabled: false)
        StubURLProtocol.responder = { _ in (402, Data(#"{"error":"quota_exceeded","entitlement":{"state":"free_floor","plan":"free","billingPeriod":"2026-10","includedMinutes":0,"usedMinutes":0,"remainingMinutes":0,"overQuota":true}}"#.utf8)) }
        // Unknown (not fetched yet): never blocks.
        XCTAssertTrue(billing.guardMeteredAction())
        XCTAssertFalse(billing.isInviteSheetPresented)
        // No minutes left: the code sheet, and the recording doesn't start.
        billing.onQuotaExceeded(entitlement: entitlement(remaining: 0))
        billing.isInviteSheetPresented = false
        XCTAssertFalse(billing.guardMeteredAction())
        XCTAssertTrue(billing.isInviteSheetPresented)
        XCTAssertFalse(billing.isPaywallPresented)
    }

    func testWithoutAPaywallAQuotaHitOpensTheCodeSheetNotThePaywall() {
        let billing = BillingService(api: api(), paywallEnabled: false)
        billing.onQuotaExceeded(entitlement: entitlement(remaining: 0))
        XCTAssertTrue(billing.isInviteSheetPresented)
        XCTAssertFalse(billing.isPaywallPresented)
    }

    func testWithAPaywallAQuotaHitStillOpensThePaywall() {
        let billing = BillingService(api: api(), paywallEnabled: true)
        billing.onQuotaExceeded(entitlement: entitlement(remaining: 0))
        XCTAssertTrue(billing.isPaywallPresented)
        XCTAssertFalse(billing.isInviteSheetPresented)
    }

    func testMinutesLeftOrUnmeteredNeverBlock() {
        let billing = BillingService(api: api(), paywallEnabled: false)
        billing.onQuotaExceeded(entitlement: entitlement(remaining: 12, state: .active))
        billing.isInviteSheetPresented = false
        XCTAssertTrue(billing.guardMeteredAction())
        billing.onQuotaExceeded(entitlement: entitlement(remaining: nil, state: .active))
        billing.isInviteSheetPresented = false
        XCTAssertTrue(billing.guardMeteredAction())
        XCTAssertFalse(billing.isInviteSheetPresented)
    }

    func testARedeemedCodeBecomesTheEntitlement() async throws {
        let billing = BillingService(api: api(), paywallEnabled: false)
        billing.onQuotaExceeded(entitlement: entitlement(remaining: 0))
        StubURLProtocol.responder = { _ in (200, Data(#"{"entitlement":{"state":"active","plan":"pro","billingPeriod":"2026-10","includedMinutes":600,"usedMinutes":0,"remainingMinutes":600,"overQuota":false},"grantEndsAt":null,"notetaker":true}"#.utf8)) }
        let r = try await billing.redeemInvite("  beta-7k2qx-m9d4r-tw8hn \n")
        XCTAssertTrue(r.notetaker)
        XCTAssertEqual(billing.entitlement?.remainingMinutes, 600)
        XCTAssertTrue(billing.guardMeteredAction())
        // Sent trimmed; the server normalises the rest. (The quota hit's analytics
        // event is sent too, in the background, so find the redeem by its path.)
        let redeem = StubURLProtocol.recorded.first { $0.url.path == "/v1/beta/redeem" }
        XCTAssertEqual(redeem?.body?["code"] as? String, "beta-7k2qx-m9d4r-tw8hn")
    }

    func testTheSheetSaysWhatWentWrongInPlainWords() {
        XCTAssertTrue(InviteCodeSheet.message(for: APIError.http(status: 400, message: "invite_invalid")).contains("isn't valid"))
        XCTAssertTrue(InviteCodeSheet.message(for: APIError.http(status: 410, message: "invite_expired")).contains("expired"))
        XCTAssertTrue(InviteCodeSheet.message(for: APIError.http(status: 409, message: "invite_used_up")).contains("new one"))
        XCTAssertTrue(InviteCodeSheet.message(for: APIError.http(status: 429, message: "rate_limited")).contains("Wait"))
        XCTAssertTrue(InviteCodeSheet.message(for: APIError.http(status: 503, message: nil)).contains("our side"))
        XCTAssertTrue(InviteCodeSheet.message(for: URLError(.notConnectedToInternet)).contains("No connection"))
    }

    func testTheSuccessLineSaysHowManyMinutesAndUntilWhen() {
        let e = EntitlementResponse(state: .active, plan: "pro", billingPeriod: "2026-10", includedMinutes: 1500,
                                    usedMinutes: 0, remainingMinutes: 1500, overQuota: false, trialEndsAt: nil)
        let until = InviteCodeSheet.successLine(RedeemInviteResponse(entitlement: e, grantEndsAt: "2026-10-29T00:00:00.000Z", notetaker: false),
                                                locale: Locale(identifier: "en_AU"))
        XCTAssertTrue(until.hasPrefix("You have 1,500 recording minutes, until 29 October."), until)
        let open = InviteCodeSheet.successLine(RedeemInviteResponse(entitlement: e, grantEndsAt: nil, notetaker: false))
        XCTAssertTrue(open.contains("for this beta"), open)
    }
}
