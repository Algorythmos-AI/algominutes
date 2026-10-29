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

    /// 5.1.1(v): the sign-in screen (after signing out or deleting the account, or when a launch couldn't make the
    /// guest) always offers to carry on without an account. CI's simulator lands there; a phone with a live project
    /// goes straight to the tabs, so it skips.
    @MainActor
    func testSignInOffersToCarryOnWithoutAnAccount() throws {
        let app = XCUIApplication()
        app.launch()

        let signIn = app.buttons["Sign in with Apple"]
        let home = app.tabBars.buttons["Home"]
        let firstScreen = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in signIn.exists || home.exists },
            object: nil
        )
        _ = XCTWaiter().wait(for: [firstScreen], timeout: 60)
        if home.exists { throw XCTSkip("a guest was made at launch: the sign-in screen isn't shown") }
        XCTAssertTrue(signIn.exists, "no sign-in screen and no tab bar within 60 s")
        let carryOn = app.buttons["login.guest"]
        XCTAssertTrue(carryOn.exists, "sign-in has no Continue without an account")
        XCTAssertEqual(carryOn.label, "Continue without an account")
        XCTAssertTrue(carryOn.isHittable, "Continue without an account can't be tapped")
    }
}
