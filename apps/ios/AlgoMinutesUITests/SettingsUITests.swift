import XCTest

/// Settings on a real account. Nothing here deletes or signs out: the destructive steps are opened and cancelled.
final class SettingsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testSettingsShowsTheAccountAndTheWayOut() throws {
        let app = try launchToTabs()
        app.openTab("Settings")

        let wifiOnly = app.switches["settings.wifiOnly"]
        XCTAssertTrue(wifiOnly.waitForExistence(timeout: 10), "no Upload on Wi-Fi only switch")
        XCTAssertTrue(scrollTo(app.element("settings.help"), in: app), "Help & Support can't be reached")
        let account = app.element("settings.account.guest").exists ? "guest" : "signed in"
        XCTAssertTrue(
            app.element("settings.account.guest").exists || app.element("settings.account.signedIn").exists,
            "the account isn't said"
        )
        let version = app.element("settings.version")
        XCTAssertTrue(scrollTo(version, in: app), "the version can't be reached")
        XCTAssertTrue(version.label.hasPrefix("v"), "the version reads \(version.label)")
        XCTAssertTrue(scrollTo(app.element("settings.signOut"), in: app), "Sign Out can't be reached")
        XCTAssertTrue(scrollTo(app.element("settings.deleteAccount"), in: app), "Delete my account can't be reached")
        screenshot(app, "settings (\(account))")
    }

    @MainActor
    func testUploadOnWifiOnlyIsKeptAcrossALaunch() throws {
        var app = try launchToTabs()
        app.openTab("Settings")
        let before = try wifiOnlyValue(app)

        try setWifiOnly(app, to: !before)
        app.terminate()
        app = try launchToTabs()
        app.openTab("Settings")
        let after = try wifiOnlyValue(app)

        // Put it back before asserting, so a failure doesn't leave the phone's setting changed.
        try setWifiOnly(app, to: before)
        XCTAssertEqual(after, !before, "Upload on Wi-Fi only wasn't kept across a launch")
        XCTAssertEqual(try wifiOnlyValue(app), before)
    }

    @MainActor
    func testDeletingTheAccountWantsBothConfirmations() throws {
        let app = try launchToTabs()
        app.openTab("Settings")
        let open = app.element("settings.deleteAccount")
        XCTAssertTrue(scrollTo(open, in: app))
        open.tap()

        let delete = app.buttons["deleteAccount.delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "the delete sheet didn't open")
        XCTAssertFalse(delete.isEnabled, "Delete forever is enabled before anything was confirmed")

        // Typing DELETE alone isn't enough: the acknowledgement is never ticked here.
        let field = app.textFields["deleteAccount.confirmText"]
        field.tap()
        field.typeText("DELETE")
        XCTAssertFalse(delete.isEnabled, "Delete forever is enabled without the acknowledgement")
        screenshot(app, "delete sheet, typed but not acknowledged")

        // Return ends editing: the keyboard covers Cancel, and a tap on it while it's up can land on a key.
        field.typeText("\n")
        _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 5)
        let cancel = app.buttons["deleteAccount.cancel"]
        if !cancel.isHittable { app.swipeUp() }
        XCTAssertTrue(cancel.isHittable, "Cancel is hidden on the delete sheet")
        cancel.tap()
        XCTAssertTrue(delete.waitForNonExistence(timeout: 5), "Cancel didn't close the delete sheet")
        XCTAssertTrue(app.tabBars.buttons["Settings"].exists)
    }

    @MainActor
    func testAGuestIsAskedBeforeSigningOut() throws {
        let app = try launchToTabs()
        app.openTab("Settings")
        guard app.element("settings.account.guest").waitForExistence(timeout: 5) else {
            // A signed-in account with nothing waiting to upload signs out at once: not tried on a real phone.
            throw XCTSkip("signed in: Sign Out would sign out without asking")
        }
        let signOut = app.element("settings.signOut")
        XCTAssertTrue(scrollTo(signOut, in: app))
        signOut.tap()

        XCTAssertTrue(app.staticTexts["Sign out of the guest account?"].waitForExistence(timeout: 5),
                      "a guest's sign-out didn't ask first")
        XCTAssertTrue(app.buttons["Create account instead"].exists)
        screenshot(app, "guest sign-out asks")
        dismissDialog(app)
        XCTAssertTrue(app.staticTexts["Sign out of the guest account?"].waitForNonExistence(timeout: 5),
                      "the sign-out question didn't close")
        XCTAssertTrue(app.element("settings.account.guest").waitForExistence(timeout: 5), "the guest was signed out")
    }

    @MainActor
    func testHelpOpensAndComesBack() throws {
        let app = try launchToTabs()
        app.openTab("Settings")
        let help = app.element("settings.help")
        XCTAssertTrue(scrollTo(help, in: app))
        help.tap()
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 5), "Help & Support didn't open")
        screenshot(app, "help & support")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.switches["settings.wifiOnly"].waitForExistence(timeout: 5), "Back didn't return to Settings")
    }

    // MARK: - Upload on Wi-Fi only

    @MainActor
    private func wifiOnlyValue(_ app: XCUIApplication) throws -> Bool {
        let toggle = app.switches["settings.wifiOnly"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "no Upload on Wi-Fi only switch")
        return try XCTUnwrap(Self.isOn(toggle.value))
    }

    @MainActor
    private func setWifiOnly(_ app: XCUIApplication, to on: Bool) throws {
        let toggle = app.switches["settings.wifiOnly"]
        if try wifiOnlyValue(app) == on { return }
        // The switch itself sits at the row's trailing edge; the label doesn't flip it.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let flipped = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in Self.isOn(toggle.value) == on }, object: nil
        )
        XCTAssertEqual(XCTWaiter().wait(for: [flipped], timeout: 5), .completed, "the switch didn't turn \(on ? "on" : "off")")
    }

    private static func isOn(_ value: Any?) -> Bool? {
        switch value as? String {
        case "1": return true
        case "0": return false
        default: return nil
        }
    }
}
