import XCTest

/// The real app, launched on the simulator, gets past startup and renders its
/// first screen. CI's Debug build has no GoogleService-Info.plist, so Firebase
/// runs on placeholder options and the anonymous sign-in can't complete: the
/// app lands on the sign-in fallback. With a live project it lands on the tabs.
/// Either one proves launch, Firebase bootstrap and the first render.
final class LaunchSmokeUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testTheAppLaunchesToItsFirstScreen() {
        let app = XCUIApplication()
        app.launch()

        let signIn = app.buttons["Sign in with Apple"]
        let google = app.buttons["Sign in with Google"]
        let home = app.tabBars.buttons["Home"]
        let firstScreen = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in signIn.exists || google.exists || home.exists },
            object: nil
        )
        let result = XCTWaiter().wait(for: [firstScreen], timeout: 60)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "first screen"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertEqual(result, .completed, "no sign-in button and no tab bar within 60 s")
        XCTAssertEqual(app.state, .runningForeground, "the app is no longer running")
    }
}
