import XCTest
@testable import AlgoMinutes

/// The App Store build's way to give someone free time (plan rev 12, Stage 3, I2): an App Store Offer Code,
/// redeemed in Apple's own sheet from Settings. It replaces the beta's invite code there. The redeemed
/// subscription reaches the server like a purchase (StoreKitService's Transaction.updates).
final class OfferCodeEntryTests: XCTestCase {
    private func entitlement(_ state: EntitlementState, source: String, rail: String? = nil) -> EntitlementResponse {
        EntitlementResponse(state: state, plan: "pro", billingPeriod: "2026-11", includedMinutes: 1500, usedMinutes: 0, remainingMinutes: 1500, overQuota: false, trialEndsAt: nil, source: source, rail: rail)
    }

    func testOfferedWhereProIsSoldInTheAppStore() {
        XCTAssertTrue(SettingsView.offersOfferCode(paywallEnabled: true, entitlement: entitlement(.freeFloor, source: "free")))
        XCTAssertTrue(SettingsView.offersOfferCode(paywallEnabled: true, entitlement: entitlement(.trialing, source: "trial")))
        XCTAssertTrue(SettingsView.offersOfferCode(paywallEnabled: true, entitlement: nil), "not fetched yet")
        // An App Store subscriber's code extends or changes the same subscription, in Apple's sheet.
        XCTAssertTrue(SettingsView.offersOfferCode(paywallEnabled: true, entitlement: entitlement(.active, source: "subscription", rail: "apple_storekit")))
    }

    // A code there would start a second subscription, past the check that refuses one before buying.
    func testNotOfferedToASubscriberBilledElsewhere() {
        XCTAssertFalse(SettingsView.offersOfferCode(paywallEnabled: true, entitlement: entitlement(.active, source: "subscription", rail: "stripe")))
        XCTAssertFalse(SettingsView.offersOfferCode(paywallEnabled: true, entitlement: entitlement(.active, source: "subscription", rail: "google_play")))
    }

    func testNotOfferedWithoutAPaywall() {
        XCTAssertFalse(SettingsView.offersOfferCode(paywallEnabled: false, entitlement: entitlement(.freeFloor, source: "free")))
    }
}
