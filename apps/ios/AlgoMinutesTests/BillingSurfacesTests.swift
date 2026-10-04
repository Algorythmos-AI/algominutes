import XCTest
@testable import AlgoMinutes

/// With the paywall off (PAYWALL_ENABLED=NO: no products on sale), no screen
/// may promise a trial, a plan or a purchase that the build can't offer.
final class BillingSurfacesTests: XCTestCase {
    private func entitlement(included: Double?, used: Double) -> EntitlementResponse {
        EntitlementResponse(state: .active, plan: "pro", billingPeriod: "2026-10", includedMinutes: included,
                            usedMinutes: used, remainingMinutes: included.map { $0 - used }, overQuota: false, trialEndsAt: nil)
    }

    // RELEASE.md rev 11, H18: the minutes as a bar, with what's left and the day they renew.
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
    private let english = Locale(identifier: "en_AU")

    func testTheMinutesBarSaysWhatIsLeftAndWhenTheyRenew() throws {
        let bar = try XCTUnwrap(SettingsView.MinutesBar(entitlement(included: 1500, used: 340), calendar: utc, locale: english))
        XCTAssertEqual(bar.fraction, 340.0 / 1500.0, accuracy: 0.0001)
        XCTAssertEqual(bar.level, .fine)
        XCTAssertEqual(bar.caption, "\(1160.formatted()) left. Your minutes renew on 1 November.")
    }

    func testTheBarWarnsFromEightyPercentAndIsFullAtTheLimitAndPastIt() throws {
        XCTAssertEqual(try XCTUnwrap(SettingsView.MinutesBar(entitlement(included: 100, used: 79.9))).level, .fine)
        XCTAssertEqual(try XCTUnwrap(SettingsView.MinutesBar(entitlement(included: 100, used: 80))).level, .nearlyUsed)
        let over = try XCTUnwrap(SettingsView.MinutesBar(entitlement(included: 100, used: 130), calendar: utc, locale: english))
        XCTAssertEqual(over.level, .used)
        XCTAssertEqual(over.fraction, 1)
        XCTAssertTrue(over.caption.hasPrefix("0 left."), over.caption)
    }

    func testThereIsNoBarWhenTheMinutesAreUnknownOrUnmetered() {
        XCTAssertNil(SettingsView.MinutesBar(nil))
        XCTAssertNil(SettingsView.MinutesBar(entitlement(included: nil, used: 12)))
        XCTAssertNil(SettingsView.MinutesBar(entitlement(included: 0, used: 0)))
    }

    func testTheRenewalDayIsTheFirstOfTheNextMonthAcrossAYearEnd() {
        XCTAssertEqual(SettingsView.MinutesBar.renewalDay(period: "2026-12", calendar: utc, locale: english), "1 January")
        XCTAssertEqual(SettingsView.MinutesBar.renewalDay(period: "2026-02", calendar: utc, locale: english), "1 March")
        for bad in ["", "2026", "2026-13", "2026-00", "soon"] {
            XCTAssertNil(SettingsView.MinutesBar.renewalDay(period: bad, calendar: utc, locale: english), bad)
        }
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
