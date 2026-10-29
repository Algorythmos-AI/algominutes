import XCTest

/// A first install, on a real phone: a brand-new guest records a note without signing in, then deletes their
/// account (App Review's path, and 5.1.1(v)), then carries on as a new guest. Opt-in, and last (device-tests.sh --fresh-guest): the launch SIGNS
/// A SIGNED-IN ACCOUNT OUT (-AMUITestFreshGuest), so whoever uses the phone signs in again afterwards (it's left
/// on a new, empty guest). A guest
/// already on the phone is used as it is, and only while it has no notes: a guest with notes is never deleted.
final class FreshGuestDeviceUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        executionTimeAllowance = 900
    }

    @MainActor
    func testANewGuestRecordsANoteThenDeletesTheirAccount() throws {
        try requireOptIn("AM_UITEST_FRESH_GUEST", "--fresh-guest")
        let app = XCUIApplication()
        app.launchArguments += ["-AMUITestFreshGuest"]
        _ = try launchToTabs(app)

        // A guest, with nothing yet.
        app.openTab("Settings")
        XCTAssertTrue(app.element("settings.account.guest").waitForExistence(timeout: 10),
                      "not a guest: the fresh-guest launch is refused while a recording waits to upload")
        let guest = try userId(app)
        app.openTab("Home")
        Thread.sleep(forTimeInterval: 3)
        guard recentNoteIds(app).isEmpty else {
            XCTFail("this guest has notes: not a fresh guest, and never deleted here")
            return
        }
        // The example is a per-phone choice (hidden once, hidden for every account), so it's said, not asserted.
        XCTContext.runActivity(named: "example note shown: \(app.element("home.example").waitForExistence(timeout: 10))") { _ in }

        // A guest records without signing in. From here the account is deleted whatever the outcome.
        continueAfterFailure = true
        do {
            try startRecording(app)
            waitUntilRecorded(app, seconds: 10)
            let noteId = try endRecording(app, before: [])
            let status = waitUntilProcessed(app, noteId: noteId, timeout: 600)
            XCTContext.runActivity(named: "outcome: \(status)") { _ in }
            XCTAssertTrue(["Ready", "Couldn’t process"].contains(status), "a guest's note wasn't processed in 10 min: \(status)")
        } catch RecordingRefused.paywall {
            // Staging, the beta: a new guest has no minutes (TRIAL_ON_FIRST_USE off, FREE_FLOOR_MINUTES unset), and an
            // invite code is how they get some. Production gives a new iPhone a 7-day trial, then 120 minutes a month.
            XCTContext.runActivity(named: "a new guest on staging has no minutes (the beta's invite codes give them)") { _ in }
        } catch {
            XCTFail("a new guest can't record: \(error.localizedDescription)")
            cleanUpRecording(app, before: [])
        }

        try deleteAccount(app, of: guest)
        XCTAssertTrue(app.buttons["Sign in with Apple"].waitForExistence(timeout: 60), "deleting the account didn't sign out")

        // 5.1.1(v): no account was needed a minute ago, and none is needed now. Deleting lands on sign-in (a new
        // account is never made by itself), which offers to carry on as a new guest, with nothing of the old one.
        let carryOn = app.buttons["login.guest"]
        XCTAssertTrue(carryOn.waitForExistence(timeout: 10), "sign-in after deleting the account has no way on without one")
        screenshot(app, "after deleting the account")
        carryOn.tap()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 60), "Continue without an account didn't reach the tabs")
        app.openTab("Settings")
        XCTAssertTrue(app.element("settings.account.guest").waitForExistence(timeout: 10), "not a guest after carrying on")
        XCTAssertNotEqual(try userId(app), guest, "carrying on brought back the deleted guest")
        app.openTab("Home")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertTrue(recentNoteIds(app).isEmpty, "the new guest has notes")
    }

    /// The User ID Settings shows.
    @MainActor
    private func userId(_ app: XCUIApplication) throws -> String {
        let row = app.element("settings.copy.User ID")
        XCTAssertTrue(scrollTo(row, in: app), "no User ID in Settings")
        let prefix = "User ID: "
        XCTAssertTrue(row.label.hasPrefix(prefix), "the User ID row reads \(row.label)")
        return String(row.label.dropFirst(prefix.count))
    }

    /// Deletes the account, but only while it's still the guest this test made.
    @MainActor
    private func deleteAccount(_ app: XCUIApplication, of guest: String) throws {
        app.openTab("Settings")
        guard app.element("settings.account.guest").waitForExistence(timeout: 10), try userId(app) == guest else {
            XCTFail("not the guest this test made: its account is left alone")
            return
        }
        let open = app.element("settings.deleteAccount")
        XCTAssertTrue(scrollTo(open, in: app))
        open.tap()
        let delete = app.buttons["deleteAccount.delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "the delete sheet didn't open")
        app.element("deleteAccount.acknowledge").tap()
        let field = app.textFields["deleteAccount.confirmText"]
        field.tap()
        field.typeText("DELETE")
        XCTAssertTrue(delete.isEnabled, "Delete forever stays disabled with both confirmations")
        delete.tap()
    }
}
