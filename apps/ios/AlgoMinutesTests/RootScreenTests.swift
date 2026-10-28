import XCTest
@testable import AlgoMinutes

/// What the root shows (RootView.screen). Signing out or deleting the account after a launch with someone signed
/// in left the launch spinner up for good (device run 2026-10-28): after launch, nobody signed in is sign-in.
final class RootScreenTests: XCTestCase {
    func testSomeoneSignedInSeesTheTabs() {
        XCTAssertEqual(RootView.screen(hasUser: true, launchSettled: false, isSigningIn: false), .tabs)
        XCTAssertEqual(RootView.screen(hasUser: true, launchSettled: true, isSigningIn: true), .tabs)
    }

    func testTheSplashShowsOnlyWhileLaunchSettlesOrASignInRuns() {
        XCTAssertEqual(RootView.screen(hasUser: false, launchSettled: false, isSigningIn: false), .splash)
        XCTAssertEqual(RootView.screen(hasUser: false, launchSettled: true, isSigningIn: true), .splash)
    }

    func testSigningOutAfterLaunchShowsSignIn() {
        XCTAssertEqual(RootView.screen(hasUser: false, launchSettled: true, isSigningIn: false), .signIn)
    }
}
