import XCTest
@testable import AlgoMinutes

/// The App Store build shows nothing of the beta (plan rev 12, Stage 3, I2). A reviewer on production would
/// have met an invite code entry, a quota that opened the invite sheet, "Pro · beta minutes" and a promise of a
/// trial production doesn't run: Guidelines 2.1 and 3.1.1 on one screen. Staging keeps the beta as it is.
@MainActor
final class StoreBuildTests: XCTestCase {
    private func api() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    /// project.yml's value for one build configuration, as the Info.plist carries it.
    private func setting(_ name: String, in config: String) throws -> String? {
        let yml = try String(contentsOfFile: #filePath.replacingOccurrences(of: "AlgoMinutesTests/StoreBuildTests.swift", with: "project.yml"), encoding: .utf8)
        guard let block = yml.range(of: "\n    \(config):\n") else { return nil }
        let rest = yml[block.upperBound...]
        let lines = rest.split(separator: "\n").prefix { $0.hasPrefix("      ") || $0.trimmingCharacters(in: .whitespaces).hasPrefix("#") }
        guard let line = lines.first(where: { $0.contains("\(name):") }) else { return nil }
        return line.split(separator: "\"").dropFirst().first.map(String.init)
    }

    func testTheStoreBuildSellsProAndTakesNoInviteCodes() throws {
        XCTAssertEqual(try setting("PAYWALL_ENABLED", in: "Release"), "YES")
        XCTAssertEqual(try setting("INVITE_CODES_ENABLED", in: "Release"), "NO")
        // The beta, on staging and in development, keeps both.
        XCTAssertEqual(try setting("INVITE_CODES_ENABLED", in: "Staging"), "YES")
        XCTAssertEqual(try setting("INVITE_CODES_ENABLED", in: "Debug"), "YES")
        XCTAssertEqual(try setting("PAYWALL_ENABLED", in: "Staging"), "YES")
    }

    func testTheInviteCodeFlagIsOnOnlyWhenSet() {
        XCTAssertTrue(AppConfig.inviteCodesEnabled(info: ["AlgoMinutesInviteCodesEnabled": "YES"]))
        XCTAssertFalse(AppConfig.inviteCodesEnabled(info: ["AlgoMinutesInviteCodesEnabled": "NO"]))
        XCTAssertFalse(AppConfig.inviteCodesEnabled(info: ["AlgoMinutesInviteCodesEnabled": "$(INVITE_CODES_ENABLED)"]))
        XCTAssertFalse(AppConfig.inviteCodesEnabled(info: nil))
    }

    func testWithoutInviteCodesNothingOpensTheInviteSheet() {
        let billing = BillingService(api: api(), paywallEnabled: true, inviteCodesEnabled: false)
        billing.presentInviteSheet()
        XCTAssertFalse(billing.isInviteSheetPresented)
        // A paywall with nothing to sell stays the paywall (it says to try again), never an invite code.
        billing.presentPaywall(.manual)
        billing.switchToInviteSheet()
        XCTAssertTrue(billing.isPaywallPresented)
        billing.paywallDismissed()
        XCTAssertFalse(billing.isInviteSheetPresented)
        // Out of minutes: the paywall.
        billing.isPaywallPresented = false
        billing.onQuotaExceeded()
        XCTAssertTrue(billing.isPaywallPresented)
        XCTAssertFalse(billing.isInviteSheetPresented)
    }

    func testTheBetaStillOpensTheInviteSheet() {
        let billing = BillingService(api: api(), paywallEnabled: true, inviteCodesEnabled: true)
        billing.presentInviteSheet()
        XCTAssertTrue(billing.isInviteSheetPresented)
    }

    func testAGrantSaysBetaMinutesOnlyInTheBeta() {
        let grant = EntitlementResponse(state: .active, plan: "pro", billingPeriod: "2026-11", includedMinutes: 600, usedMinutes: 0, remainingMinutes: 600, overQuota: false, trialEndsAt: nil, source: "grant", rail: nil)
        XCTAssertEqual(SettingsView.planLabel(grant, trialDaysRemaining: nil, beta: true), "Pro · beta minutes")
        XCTAssertEqual(SettingsView.planLabel(grant, trialDaysRemaining: nil, beta: false), "Pro")
    }

    func testTheHeldNoteSaysWhereMinutesComeFromInThisBuild() {
        let store = HeldForMinutesPane.nextStep(inviteCodes: false)
        XCTAssertFalse(store.localizedCaseInsensitiveContains("invite"))
        XCTAssertTrue(store.contains("Go Pro"))
        XCTAssertTrue(HeldForMinutesPane.nextStep(inviteCodes: true).contains("invite code"))
    }

    func testAPaywallWithNothingToSellOffersNoInviteCodeInTheStoreBuild() {
        XCTAssertFalse(PaywallView.unavailableMessage(inviteCodes: false).localizedCaseInsensitiveContains("invite"))
        XCTAssertTrue(PaywallView.unavailableMessage(inviteCodes: true).contains("invite code"))
    }

    // Production starts with the trial off (until DeviceCheck is set up there): the account prompt promises a
    // trial only to someone who is in one.
    func testTheAccountPromptPromisesATrialOnlyDuringOne() {
        XCTAssertTrue(AccountUpgradeSheet.message(trialing: true).contains("7-day trial"))
        let none = AccountUpgradeSheet.message(trialing: false)
        XCTAssertFalse(none.contains("trial"))
        XCTAssertTrue(none.hasPrefix("Create a free account"))
    }
}
