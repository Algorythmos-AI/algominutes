import XCTest
@testable import AlgoMinutes

/// The free plan records while it has minutes (App Review 2.1): after the trial, or on a device that has had one,
/// a free account with minutes left must not meet the paywall before every recording. Only out of minutes does it.
@MainActor
final class FreePlanGateTests: XCTestCase {
    private func entitlement(_ state: EntitlementState, remaining: Double?, overQuota: Bool = false) -> EntitlementResponse {
        EntitlementResponse(state: state, plan: "free", billingPeriod: "2026-10", includedMinutes: remaining == nil ? nil : 120,
                            usedMinutes: 0, remainingMinutes: remaining, overQuota: overQuota, trialEndsAt: nil)
    }

    func testAFreeAccountWithMinutesLeftIsNotGated() {
        XCTAssertFalse(entitlement(.freeFloor, remaining: 120).gatesMeteredActions)
        XCTAssertFalse(entitlement(.expired, remaining: 3).gatesMeteredActions)
        XCTAssertFalse(entitlement(.freeFloor, remaining: nil).gatesMeteredActions, "unmetered: the server decides")
    }

    func testOutOfMinutesIsGated() {
        XCTAssertTrue(entitlement(.freeFloor, remaining: 0, overQuota: true).gatesMeteredActions)
        XCTAssertTrue(entitlement(.expired, remaining: 0).gatesMeteredActions)
        XCTAssertTrue(entitlement(.freeFloor, remaining: 5, overQuota: true).gatesMeteredActions)
    }

    func testTrialAndProNeverGate() {
        XCTAssertFalse(entitlement(.trialing, remaining: 0, overQuota: true).gatesMeteredActions)
        XCTAssertFalse(entitlement(.active, remaining: 0, overQuota: true).gatesMeteredActions)
    }

    func testWithThePaywallOnAFreeAccountWithMinutesRecords() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        StubURLProtocol.recorded = []
        StubURLProtocol.responder = { _ in
            (200, Data(#"{"state":"free_floor","plan":"free","billingPeriod":"2026-10","includedMinutes":120,"usedMinutes":0,"remainingMinutes":120,"overQuota":false,"trialEndsAt":null,"source":"free"}"#.utf8))
        }
        let billing = BillingService(api: APIClient(session: URLSession(configuration: config), idToken: { "t" }), paywallEnabled: true)
        await billing.refresh()
        XCTAssertEqual(billing.entitlement?.remainingMinutes, 120)
        XCTAssertTrue(billing.guardMeteredAction())
        XCTAssertFalse(billing.isPaywallPresented)

        billing.onQuotaExceeded(entitlement: entitlement(.freeFloor, remaining: 0, overQuota: true))
        billing.isPaywallPresented = false
        XCTAssertFalse(billing.guardMeteredAction())
        XCTAssertTrue(billing.isPaywallPresented)
    }
}
