import XCTest

/// The App Store screenshots, from a real phone: Home with the example note, its summary (with the "Written by
/// Algorythmos AI" label) and transcript, and the Pro plans sheet, which is also the subscription's review
/// screenshot. Each is attached to the result bundle, kept always, named for its place in the listing; pull them
/// out with `xcrun xcresulttool export attachments`. On an account that already has notes the example note isn't
/// shown, so the note shots are skipped. Nothing is recorded, bought or changed.
final class StoreScreenshotsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testTheStoreScreenshots() throws {
        let app = try launchToTabs()
        app.openTab("Home")
        dismissAppAlerts(app)
        let example = app.element("home.example")
        guard example.waitForExistence(timeout: 10) else {
            throw XCTSkip("this account has notes, so Home shows no example note: use a new account for the screenshots")
        }
        Thread.sleep(forTimeInterval: 1)
        shot(app, "1-home")

        example.tap()
        XCTAssertTrue(app.navigationBars["Example note"].waitForExistence(timeout: 10), "the example note didn't open")
        let summary = app.segmentedControls.buttons["Summary"]
        if summary.exists { summary.tap() }
        Thread.sleep(forTimeInterval: 1)
        shot(app, "2-summary")

        let transcript = app.segmentedControls.buttons["Transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 5), "no Transcript tab on the example note")
        transcript.tap()
        Thread.sleep(forTimeInterval: 1)
        shot(app, "3-transcript")
        goBack(app)

        // The Pro plans sheet: the listing's last shot and the subscription's review screenshot.
        app.openTab("Settings")
        let goPro = app.buttons["Go Pro"]
        guard scrollTo(goPro, in: app) else {
            throw XCTSkip("Settings offers no Go Pro here (already Pro, or the paywall is off in this build)")
        }
        goPro.tap()
        XCTAssertTrue(app.navigationBars["AlgoMinutes Pro"].waitForExistence(timeout: 15), "the Pro plans sheet didn't open")
        Thread.sleep(forTimeInterval: 3) // the App Store prices load
        shot(app, "4-pro-plans")
        app.buttons["Close"].firstMatch.tap()
    }

    @MainActor
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "store-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
