import XCTest
@testable import AlgoMinutes

/// Pro in the beta (docs/plans/RELEASE.md PR 27): nobody already subscribed is
/// sold a second subscription (StoreKit buys on the device, where the server
/// can't refuse), and a paywall with nothing to sell hands over to the invite
/// code rather than being a dead end.
///
/// Purchase, restore and renewal against StoreKitTest aren't here: under
/// command-line xcodebuild, storekitd refuses an SKTestSession's configuration
/// (SKInternalErrorDomain 3, signed or not; BLOCKERS). The sandbox purchase on
/// a device is their proof (RELEASE.md Wave 2 proof 4).
@MainActor
final class PaywallBetaTests: XCTestCase {
    /// What /v1/entitlement answers: the source the pre-purchase check reads.
    private var entitlementSource = "free"
    private var entitlementRail: String?

    private func api() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    override func setUp() {
        super.setUp()
        entitlementSource = "free"
        entitlementRail = nil
        StubURLProtocol.recorded = []
        StubURLProtocol.responder = { [unowned self] req in
            guard req.url?.path == "/v1/entitlement" else { return (200, Data("{}".utf8)) }
            let state = self.entitlementSource == "free" ? "free_floor" : self.entitlementSource == "trial" ? "trialing" : "active"
            let rail = self.entitlementRail.map { #""\#($0)""# } ?? "null"
            return (200, Data(#"{"state":"\#(state)","plan":"pro","billingPeriod":"2026-10","includedMinutes":1500,"usedMinutes":0,"remainingMinutes":1500,"overQuota":false,"source":"\#(self.entitlementSource)","rail":\#(rail)}"#.utf8))
        }
    }

    func testTheCheckBeforeBuyingRefusesAnyoneAlreadySubscribedOnAnyStore() async {
        let billing = BillingService(api: api(), paywallEnabled: true)
        entitlementSource = "subscription"
        entitlementRail = "apple_storekit"
        let inAppStore = await billing.purchaseGate()
        XCTAssertEqual(inAppStore, .alreadySubscribed(managedInAppStore: true))
        entitlementRail = "stripe"
        let onTheWeb = await billing.purchaseGate()
        XCTAssertEqual(onTheWeb, .alreadySubscribed(managedInAppStore: false))
        XCTAssertTrue(StubURLProtocol.recorded.contains { $0.url.path == "/v1/entitlement" }, "read again, not from memory")
    }

    func testBetaMinutesTheTrialOrTheFreeFloorCanBuy() async {
        let billing = BillingService(api: api(), paywallEnabled: true)
        for source in ["grant", "trial", "free"] {
            entitlementSource = source
            let gate = await billing.purchaseGate()
            XCTAssertEqual(gate, .allowed, source)
        }
    }

    func testAPaywallWithNothingToSellHandsOverToTheInviteCode() {
        let billing = BillingService(api: api(), paywallEnabled: true)
        billing.presentPaywall(.manual)
        XCTAssertTrue(billing.isPaywallPresented)
        billing.switchToInviteSheet()
        XCTAssertFalse(billing.isPaywallPresented)
        XCTAssertFalse(billing.isInviteSheetPresented, "not while the paywall is still closing")
        billing.paywallDismissed()
        XCTAssertTrue(billing.isInviteSheetPresented)
    }

    func testAnOrdinaryCloseOpensNothing() {
        let billing = BillingService(api: api(), paywallEnabled: true)
        billing.presentPaywall(.manual)
        billing.isPaywallPresented = false
        billing.paywallDismissed()
        XCTAssertFalse(billing.isInviteSheetPresented)
    }

    func testTheStagingBuildSellsProAndReleaseDoesNotYet() throws {
        // project.yml's PAYWALL_ENABLED, as the Info.plist carries it.
        let yml = try String(contentsOfFile: #filePath.replacingOccurrences(of: "AlgoMinutesTests/PaywallBetaTests.swift", with: "project.yml"), encoding: .utf8)
        func flag(_ config: String) -> String? {
            guard let block = yml.range(of: "\n    \(config):\n") else { return nil }
            let rest = yml[block.upperBound...]
            guard let line = rest.split(separator: "\n").first(where: { $0.contains("PAYWALL_ENABLED:") }) else { return nil }
            return line.split(separator: "\"").dropFirst().first.map(String.init)
        }
        XCTAssertEqual(flag("Staging"), "YES")
        XCTAssertEqual(flag("Release"), "NO")
        XCTAssertTrue(AppConfig.paywallEnabled(info: ["AlgoMinutesPaywallEnabled": "YES"]))
        XCTAssertFalse(AppConfig.paywallEnabled(info: ["AlgoMinutesPaywallEnabled": "NO"]))
    }
}
