import XCTest
@testable import AlgoMinutes

/// The Debug-only launch arguments the UI tests steer the app with (UITestHooks).
final class UITestHooksTests: XCTestCase {
    func testTheClientVersionIsTheValueAfterItsFlag() {
        XCTAssertEqual(UITestHooks.clientVersion(arguments: ["app", "-AMUITestClientVersion", "0.9.0"]), "0.9.0")
    }

    func testNoFlagOrNoValueLeavesTheRealVersion() {
        XCTAssertNil(UITestHooks.clientVersion(arguments: ["app"]))
        XCTAssertNil(UITestHooks.clientVersion(arguments: ["app", "-AMUITestClientVersion"]))
        XCTAssertNil(UITestHooks.clientVersion(arguments: ["app", "-AMUITestClientVersion", " "]))
        XCTAssertNil(UITestHooks.clientVersion(arguments: ["app", "-AMUITestClientVersion", "-UIPreferredContentSizeCategoryName"]))
    }

    /// The unit tests launch the app without the flag: the header carries the bundle's own version.
    func testTheHeaderIsTheBundlesVersionWithoutTheFlag() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        XCTAssertEqual(APIClient.clientHeaderValue, "ios/\(version)")
    }
}
