import XCTest
@testable import AlgoMinutes

/// Plan rev 12 S8 (the iPhone half): a new user's trial depends on a DeviceCheck token, and a user's row is never
/// changed afterwards, so one failed attempt left that user on the free floor for good. It's asked once more.
final class DeviceAttestationTests: XCTestCase {
    private struct Transient: Error {}

    func testAFailedTokenIsAskedForOnceMore() async {
        var calls = 0
        var waited = 0
        let token = await DeviceAttestationService.attestationToken(
            supported: true,
            generate: { calls += 1; if calls == 1 { throw Transient() }; return Data("tok".utf8) },
            wait: { waited += 1 }
        )
        XCTAssertEqual(token, Data("tok".utf8).base64EncodedString())
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(waited, 1)
    }

    func testTwoFailuresGiveNoToken() async {
        var calls = 0
        let token = await DeviceAttestationService.attestationToken(
            supported: true, generate: { calls += 1; throw Transient() }, wait: {}
        )
        XCTAssertNil(token)
        XCTAssertEqual(calls, 2)
    }

    func testAnUnsupportedDeviceIsNeverAsked() async {
        var calls = 0
        let token = await DeviceAttestationService.attestationToken(
            supported: false, generate: { calls += 1; return Data() }, wait: {}
        )
        XCTAssertNil(token)
        XCTAssertEqual(calls, 0)
    }

    func testAFirstTokenIsUsedAtOnce() async {
        var waited = 0
        let token = await DeviceAttestationService.attestationToken(
            supported: true, generate: { Data("ok".utf8) }, wait: { waited += 1 }
        )
        XCTAssertEqual(token, Data("ok".utf8).base64EncodedString())
        XCTAssertEqual(waited, 0)
    }
}
