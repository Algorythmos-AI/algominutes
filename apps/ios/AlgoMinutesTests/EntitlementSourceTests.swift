import XCTest
@testable import AlgoMinutes

/// Where an entitlement comes from (docs/plans/RELEASE.md PR 26b). A grant (an
/// invite code) reports `active` like a subscription, so the funnel counts a
/// purchase, and Settings offers "Manage Subscription", only for a subscription,
/// and only one bought in the App Store is managed there.
@MainActor
final class EntitlementSourceTests: XCTestCase {
    private func api() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    private func entitlement(_ state: EntitlementState, source: String?, rail: String? = nil) -> EntitlementResponse {
        EntitlementResponse(state: state, plan: state == .active ? "pro" : "free", billingPeriod: "2026-10", includedMinutes: 600,
                            usedMinutes: 0, remainingMinutes: 600, overQuota: false, trialEndsAt: nil, source: source, rail: rail)
    }

    private func json(_ state: String, source: String, rail: String? = nil) -> Data {
        let railField = rail.map { #","rail":"\#($0)""# } ?? #","rail":null"#
        return Data(#"{"state":"\#(state)","plan":"pro","billingPeriod":"2026-10","includedMinutes":600,"usedMinutes":0,"remainingMinutes":600,"overQuota":false,"source":"\#(source)"\#(railField)}"#.utf8)
    }

    /// The purchase and cancellation events sent (seeding the entitlement as a 402
    /// does also sends quota_hit and paywall_viewed, which aren't under test here).
    private var events: [String] {
        StubURLProtocol.recorded.filter { $0.url.path == "/v1/events" }.compactMap { $0.body?["event"] as? String }
            .filter { $0 == "purchase" || $0 == "cancellation" }
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.recorded = []
        StubURLProtocol.responder = { _ in (200, Data("{}".utf8)) }
    }

    func testDecodesTheSourceAndRailAndAServerFromBeforeThem() throws {
        let e = try JSONDecoder().decode(EntitlementResponse.self, from: json("active", source: "subscription", rail: "stripe"))
        XCTAssertEqual(e.source, "subscription")
        XCTAssertEqual(e.rail, "stripe")
        let old = try JSONDecoder().decode(EntitlementResponse.self, from: Data(#"{"state":"active","plan":"pro","billingPeriod":"2026-10","includedMinutes":600,"usedMinutes":0,"remainingMinutes":600,"overQuota":false}"#.utf8))
        XCTAssertNil(old.source)
        XCTAssertTrue(old.isSubscription, "an older server's active counts as before")
        XCTAssertTrue(old.isManagedInAppStore)
        // A source this build doesn't know decodes, and is no subscription.
        let newer = try JSONDecoder().decode(EntitlementResponse.self, from: json("active", source: "something_new"))
        XCTAssertFalse(newer.isSubscription)
    }

    func testOnlyAnAppStoreSubscriptionIsManagedThere() {
        XCTAssertTrue(entitlement(.active, source: "subscription", rail: "apple_storekit").isManagedInAppStore)
        XCTAssertFalse(entitlement(.active, source: "subscription", rail: "stripe").isManagedInAppStore)
        XCTAssertFalse(entitlement(.active, source: "grant").isManagedInAppStore)
        XCTAssertFalse(entitlement(.trialing, source: "trial").isManagedInAppStore)
        XCTAssertFalse(entitlement(.freeFloor, source: "free").isManagedInAppStore)
    }

    func testSettingsSaysAGrantsMinutesAreBetaMinutes() {
        XCTAssertEqual(SettingsView.planLabel(entitlement(.active, source: "grant"), trialDaysRemaining: nil), "Pro · beta minutes")
        XCTAssertEqual(SettingsView.planLabel(entitlement(.active, source: "subscription", rail: "apple_storekit"), trialDaysRemaining: nil), "Pro")
        XCTAssertEqual(SettingsView.planLabel(entitlement(.trialing, source: "trial"), trialDaysRemaining: 3), "Free trial · 3 days left")
    }

    func testABuyerWithBetaMinutesCountsAsAPurchase() async {
        let billing = BillingService(api: api(), paywallEnabled: true)
        billing.onQuotaExceeded(entitlement: entitlement(.active, source: "grant")) // sets it, as a 402 does
        StubURLProtocol.responder = { req in
            req.url?.path == "/v1/entitlement" ? (200, self.json("active", source: "subscription", rail: "apple_storekit")) : (200, Data("{}".utf8))
        }
        await billing.store.onEntitlementMayHaveChanged?()
        XCTAssertEqual(events, ["purchase"])
    }

    func testRedeemingACodeIsNoPurchaseAndItsEndIsNoCancellation() async {
        let billing = BillingService(api: api(), paywallEnabled: true)
        billing.onQuotaExceeded(entitlement: entitlement(.freeFloor, source: "free")) // sets it, as a 402 does
        StubURLProtocol.responder = { req in
            req.url?.path == "/v1/entitlement" ? (200, self.json("active", source: "grant")) : (200, Data("{}".utf8))
        }
        await billing.store.onEntitlementMayHaveChanged?()
        StubURLProtocol.responder = { req in
            req.url?.path == "/v1/entitlement" ? (200, self.json("free_floor", source: "free")) : (200, Data("{}".utf8))
        }
        await billing.refresh()
        XCTAssertEqual(events, [])
    }

    func testASubscriptionLapsingIsACancellation() async {
        let billing = BillingService(api: api(), paywallEnabled: true)
        billing.onQuotaExceeded(entitlement: entitlement(.active, source: "subscription", rail: "apple_storekit")) // sets it, as a 402 does
        StubURLProtocol.responder = { req in
            req.url?.path == "/v1/entitlement" ? (200, self.json("free_floor", source: "free")) : (200, Data("{}".utf8))
        }
        await billing.refresh()
        XCTAssertEqual(events, ["cancellation"])
    }
}
