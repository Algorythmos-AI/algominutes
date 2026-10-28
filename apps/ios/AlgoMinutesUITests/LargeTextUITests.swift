import XCTest

/// The largest text size the system offers. RootView clamps Dynamic Type at accessibility3, so this is the size
/// the app actually draws at; every tab's main controls must still be reachable and tappable.
final class LargeTextUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testEveryTabWorksAtTheLargestTextSize() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        _ = try launchToTabs(app)

        for tab in ["Home", "Files", "Settings"] {
            XCTAssertTrue(app.tabBars.buttons[tab].isHittable, "the \(tab) tab can't be tapped")
        }

        let record = app.element("home.action.recording")
        XCTAssertTrue(record.waitForExistence(timeout: 10), "no Instant Recorder on Home")
        XCTAssertTrue(record.isHittable, "Instant Recorder can't be tapped")
        XCTAssertTrue(scrollTo(app.element("home.action.scanText"), in: app), "Scan Text can't be reached")
        screenshot(app, "home, largest text")

        app.openTab("Files")
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 10), "Files didn't open")
        screenshot(app, "files, largest text")

        app.openTab("Settings")
        XCTAssertTrue(app.switches["settings.wifiOnly"].waitForExistence(timeout: 10))
        XCTAssertTrue(scrollTo(app.switches["settings.wifiOnly"], in: app), "Upload on Wi-Fi only can't be reached")
        XCTAssertTrue(scrollTo(app.element("settings.deleteAccount"), in: app, swipes: 20),
                      "Delete my account can't be reached")
        screenshot(app, "settings, largest text")
    }
}
