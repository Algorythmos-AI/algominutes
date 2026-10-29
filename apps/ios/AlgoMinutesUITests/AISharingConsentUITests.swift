import XCTest

/// The Google Cloud AI agreement (App Store 5.1.2(i)), from a phone that hasn't given it: asked before a recording
/// starts, "Not now" sends nothing and leaves Home as it was, Agree carries on to the recording sheet (needs an
/// account with minutes); and, on any account, Settings asks it, shows it and can withdraw it. Nothing is recorded or uploaded. The launch forgets the agreement
/// (-AMUITestAISharingReset, Debug only); the test ends with it given again, as it found the phone.
final class AISharingConsentUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testTheAgreementIsAskedBeforeRecording_andCanBeWithdrawnInSettings() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-AMUITestAISharingReset"]
        _ = try launchToTabs(app)

        // Asked before the recording sheet: it names Google Cloud.
        app.openTab("Home")
        let record = app.element("home.action.recording")
        XCTAssertTrue(record.waitForExistence(timeout: 10), "no Instant Recorder on Home")
        record.tap()
        let agree = app.buttons["aiSharing.agree"]
        guard agree.waitForExistence(timeout: 10) else {
            if app.navigationBars["AlgoMinutes Pro"].exists {
                app.buttons["Close"].firstMatch.tap()
                throw XCTSkip("the paywall came up instead: this account has no minutes to record with")
            }
            XCTFail("the Google Cloud AI agreement wasn't asked before recording")
            return
        }
        XCTAssertEqual(app.element("aiSharing.title").label, "Send your recordings to Google Cloud AI?")
        XCTAssertTrue(app.element("aiSharing.body").label.contains("Google Cloud"))
        XCTAssertTrue(app.buttons["aiSharing.notNow"].exists)
        screenshot(app, "Google Cloud AI agreement")

        // Not now: nothing opens, Home is as it was.
        app.buttons["aiSharing.notNow"].tap()
        XCTAssertFalse(app.buttons["recorder.consent.start"].waitForExistence(timeout: 3),
                       "the recording sheet opened after Not now")
        XCTAssertTrue(record.waitForExistence(timeout: 5))

        // Asked again next time; Agree carries on to the recording sheet (its own tick, unchanged), cancelled.
        record.tap()
        XCTAssertTrue(agree.waitForExistence(timeout: 10), "Not now didn't leave it to be asked again")
        agree.tap()
        XCTAssertTrue(app.buttons["recorder.consent.start"].waitForExistence(timeout: 10),
                      "Agree didn't carry on to the recording sheet")
        XCTAssertTrue(app.element("recorder.consent.acknowledge").exists, "the permission tick is gone")
        app.buttons["recorder.consent.cancel"].tap()

        // Given again, as the test found the phone (Settings is proven on its own below).
        app.openTab("Settings")
        XCTAssertTrue(scrollTo(app.element("settings.aiSharing.on"), in: app), "Settings didn't say it's on")
    }

    /// Needs no minutes, so it runs on any account: the sheet itself, Not now, Agree, and withdrawing in Settings.
    @MainActor
    func testSettingsAsksTheAgreementAndCanWithdrawIt() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-AMUITestAISharingReset"]
        _ = try launchToTabs(app)

        app.openTab("Settings")
        XCTAssertTrue(scrollTo(app.element("settings.aiSharing.off"), in: app), "Settings didn't say it's off on a fresh phone")
        let turnOn = app.buttons["settings.aiSharing.agree"]
        XCTAssertTrue(scrollTo(turnOn, in: app), "Settings doesn't offer to turn it on")

        // The sheet names Google Cloud and what is sent; Not now leaves it off.
        turnOn.tap()
        let agree = app.buttons["aiSharing.agree"]
        XCTAssertTrue(agree.waitForExistence(timeout: 10), "turning it on didn't show the agreement")
        XCTAssertEqual(app.element("aiSharing.title").label, "Send your recordings to Google Cloud AI?")
        XCTAssertTrue(app.element("aiSharing.body").label.contains("Google Cloud"))
        screenshot(app, "Google Cloud AI agreement from Settings")
        app.buttons["aiSharing.notNow"].tap()
        XCTAssertTrue(app.element("settings.aiSharing.off").waitForExistence(timeout: 5), "Not now turned it on")

        // Agree turns it on.
        XCTAssertTrue(scrollTo(turnOn, in: app))
        turnOn.tap()
        XCTAssertTrue(agree.waitForExistence(timeout: 10))
        agree.tap()
        XCTAssertTrue(app.element("settings.aiSharing.on").waitForExistence(timeout: 5), "Settings didn't say it's on")

        // Withdrawing asks first and says it's off.
        let withdraw = app.buttons["settings.aiSharing.withdraw"]
        XCTAssertTrue(scrollTo(withdraw, in: app), "Settings doesn't offer to stop sending")
        withdraw.tap()
        let confirm = app.buttons["Stop sending"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "stopping didn't ask first")
        confirm.tap()
        XCTAssertTrue(app.element("settings.aiSharing.off").waitForExistence(timeout: 5), "Settings didn't say it's off")
        screenshot(app, "Google Cloud AI off")

        // Given again, as the test found the phone.
        XCTAssertTrue(scrollTo(turnOn, in: app))
        turnOn.tap()
        XCTAssertTrue(agree.waitForExistence(timeout: 10))
        agree.tap()
        XCTAssertTrue(app.element("settings.aiSharing.on").waitForExistence(timeout: 5))
    }
}
