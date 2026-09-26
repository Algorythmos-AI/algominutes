import XCTest
@testable import AlgoMinutes

/// With the paywall off (PAYWALL_ENABLED=NO: no products on sale), no screen
/// may promise a trial, a plan or a purchase that the build can't offer.
final class BillingSurfacesTests: XCTestCase {
    private func entitlement(included: Double?, used: Double) -> EntitlementResponse {
        EntitlementResponse(state: .active, plan: "pro", billingPeriod: "2026-10", includedMinutes: included,
                            usedMinutes: used, remainingMinutes: included.map { $0 - used }, overQuota: false, trialEndsAt: nil)
    }

    func testSettingsShowsTheServersMinutes() {
        XCTAssertEqual(SettingsView.minutesLine(entitlement(included: 1500, used: 340.7)),
                       "340 of \(1500.formatted()) minutes used this month")
        XCTAssertNil(SettingsView.minutesLine(entitlement(included: nil, used: 12)), "unmetered")
        XCTAssertNil(SettingsView.minutesLine(entitlement(included: 0, used: 0)))
        XCTAssertNil(SettingsView.minutesLine(nil))
    }

    func testTheAccountPromptMentionsTheTrialOnlyWithAPaywall() {
        XCTAssertTrue(AccountUpgradeSheet.message(paywallEnabled: true).contains("7-day trial"))
        let off = AccountUpgradeSheet.message(paywallEnabled: false)
        XCTAssertFalse(off.contains("trial"))
        XCTAssertTrue(off.hasPrefix("Create a free account"))
    }
}
