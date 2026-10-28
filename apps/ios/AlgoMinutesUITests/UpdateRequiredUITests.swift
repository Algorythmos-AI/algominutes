import XCTest

/// A build below the api's minimum (X-AlgoMinutes-Client, services/api client-version.js) is covered by the
/// update screen, from the real server's 426. The Debug-only `-AMUITestClientVersion` makes this build report an
/// old version; nothing about it persists, so the next normal launch is unaffected.
final class UpdateRequiredUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testAnOldVersionGetsTheUpdateScreenFromTheServer() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-AMUITestClientVersion", "0.9.0"]
        app.launch()

        let screen = app.element("update.screen")
        try waitPastSignIn(app, for: screen)
        XCTAssertEqual(screen.label, "Update AlgoMinutes")
        XCTAssertTrue(app.element("update.button").exists, "the screen offers no way to update")
        screenshot(app, "update screen")

        // There is no way past it but the update.
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(screen.waitForExistence(timeout: 2), "the update screen was dismissed")
    }

    @MainActor
    func testTheCurrentVersionIsNotAskedToUpdate() throws {
        let app = try launchToTabs()
        // Long enough for launch's api calls (entitlement, switches) to have answered.
        XCTAssertFalse(app.element("update.screen").waitForExistence(timeout: 15), "the current build was told to update")
    }
}
