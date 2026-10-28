import XCTest

/// What the UI tests share. They run against a Debug build, which talks to staging: on a phone with
/// GoogleService-Info.plist the app reaches its tabs; CI's simulator build has no Firebase project and stops at
/// the sign-in fallback, so a test that needs the tabs skips there (docs/runbooks/device-tests.md).
extension XCTestCase {
    /// Launches the app and waits for its tab bar. Skips when the app lands on sign-in instead.
    @MainActor
    func launchToTabs(_ app: XCUIApplication = XCUIApplication(), file: StaticString = #filePath, line: UInt = #line) throws -> XCUIApplication {
        app.launch()
        let home = app.tabBars.buttons["Home"]
        try waitPastSignIn(app, for: home, file: file, line: line)
        return app
    }

    /// Waits up to `timeout` for `element`; skips if the sign-in fallback shows first.
    @MainActor
    func waitPastSignIn(_ app: XCUIApplication, for element: XCUIElement, timeout: TimeInterval = 60,
                        file: StaticString = #filePath, line: UInt = #line) throws {
        let signIn = app.buttons["Sign in with Apple"]
        let reached = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in element.exists || signIn.exists },
            object: nil
        )
        _ = XCTWaiter().wait(for: [reached], timeout: timeout)
        if !element.exists, signIn.exists {
            throw XCTSkip("the app stopped at sign-in: this build has no live Firebase project")
        }
        XCTAssertTrue(element.exists, "\(element) didn't appear within \(Int(timeout)) s", file: file, line: line)
    }

    /// Swipes up until `element` can be tapped. False if it never could.
    @MainActor
    @discardableResult
    func scrollTo(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 10) -> Bool {
        for _ in 0..<swipes {
            if element.exists, element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }

    @MainActor
    func screenshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}

extension XCUIApplication {
    /// The first element anywhere in the app with this accessibility identifier.
    func element(_ identifier: String) -> XCUIElement {
        descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    @MainActor
    func openTab(_ name: String) {
        tabBars.buttons[name].tap()
    }
}
