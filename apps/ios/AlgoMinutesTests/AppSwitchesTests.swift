import XCTest
@testable import AlgoMinutes

/// Broadcast capture's kill switch: hidden until the server first answers,
/// then whatever it last said, kept across launches and failed fetches.
@MainActor
final class AppSwitchesTests: XCTestCase {
    private struct Offline: Error {}
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "AppSwitchesTests")
        defaults.removePersistentDomain(forName: "AppSwitchesTests")
    }

    func testHiddenUntilTheServerAnswers() async {
        let switches = AppSwitches(defaults: defaults)
        XCTAssertFalse(switches.broadcastCapture)
        await switches.refresh { throw Offline() }
        XCTAssertFalse(switches.broadcastCapture)
        await switches.refresh { AppConfigResponse(broadcastCapture: true) }
        XCTAssertTrue(switches.broadcastCapture)
    }

    func testTheLastAnswerIsKeptAcrossLaunchesAndFailures() async {
        await AppSwitches(defaults: defaults).refresh { AppConfigResponse(broadcastCapture: true) }
        let relaunched = AppSwitches(defaults: defaults)
        XCTAssertTrue(relaunched.broadcastCapture)
        await relaunched.refresh { throw Offline() }
        XCTAssertTrue(relaunched.broadcastCapture)
    }

    func testTheServerCanTurnItOff() async {
        let switches = AppSwitches(defaults: defaults)
        await switches.refresh { AppConfigResponse(broadcastCapture: true) }
        await switches.refresh { AppConfigResponse(broadcastCapture: false) }
        XCTAssertFalse(switches.broadcastCapture)
        XCTAssertFalse(AppSwitches(defaults: defaults).broadcastCapture)
    }

    func testTheResponseDecodes() throws {
        let body = Data(#"{"broadcastCapture":false}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(AppConfigResponse.self, from: body), AppConfigResponse(broadcastCapture: false))
    }
}
