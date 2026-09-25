import XCTest
@testable import AlgoMinutes

/// The FCM token reaches the api once per signed-in user: not before sign-in,
/// not twice for the same pair, again for a new token or a new user, again
/// after a failure. Signing out deletes it.
@MainActor
final class PushTokenRegistrarTests: XCTestCase {
    private struct Refused: Error {}

    private final class Calls {
        var registered: [String] = []
        var deletes = 0
        var failNext = false
    }

    private func makeRegistrar(_ calls: Calls) -> PushTokenRegistrar {
        let registrar = PushTokenRegistrar(appVersion: "1.0") { token, _ in
            if calls.failNext {
                calls.failNext = false
                throw Refused()
            }
            calls.registered.append(token)
        }
        registrar.deleteDeviceToken = { calls.deletes += 1 }
        return registrar
    }

    func testATokenBeforeSignInWaitsForIt() async {
        let calls = Calls()
        let registrar = makeRegistrar(calls)
        await registrar.tokenRefreshed("fcm-1")
        XCTAssertEqual(calls.registered, [])
        await registrar.userChanged(uid: "u1")
        XCTAssertEqual(calls.registered, ["fcm-1"])
    }

    func testTheSameTokenAndUserRegistersOnce() async {
        let calls = Calls()
        let registrar = makeRegistrar(calls)
        await registrar.userChanged(uid: "u1")
        await registrar.tokenRefreshed("fcm-1")
        await registrar.tokenRefreshed("fcm-1")
        await registrar.userChanged(uid: "u1")
        XCTAssertEqual(calls.registered, ["fcm-1"])
    }

    func testARefreshedTokenOrANewUserRegistersAgain() async {
        let calls = Calls()
        let registrar = makeRegistrar(calls)
        await registrar.userChanged(uid: "u1")
        await registrar.tokenRefreshed("fcm-1")
        await registrar.tokenRefreshed("fcm-2")
        await registrar.userChanged(uid: "u2")
        XCTAssertEqual(calls.registered, ["fcm-1", "fcm-2", "fcm-2"])
    }

    func testAFailedRegistrationIsTriedAgain() async {
        let calls = Calls()
        let registrar = makeRegistrar(calls)
        await registrar.userChanged(uid: "u1")
        calls.failNext = true
        await registrar.tokenRefreshed("fcm-1")
        XCTAssertEqual(calls.registered, [])
        await registrar.tokenRefreshed("fcm-1")
        XCTAssertEqual(calls.registered, ["fcm-1"])
    }

    func testSigningOutDeletesTheTokenAndTheNextUserGetsANewOne() async {
        let calls = Calls()
        let registrar = makeRegistrar(calls)
        await registrar.userChanged(uid: "u1")
        await registrar.tokenRefreshed("fcm-1")
        await registrar.userChanged(uid: nil)
        XCTAssertEqual(calls.deletes, 1)
        // The deleted token isn't registered for the next user; FCM's new one is.
        await registrar.userChanged(uid: "u2")
        XCTAssertEqual(calls.registered, ["fcm-1"])
        await registrar.tokenRefreshed("fcm-3")
        XCTAssertEqual(calls.registered, ["fcm-1", "fcm-3"])
    }

    func testNoSignOutDeleteBeforeAnyoneSignedIn() async {
        let calls = Calls()
        let registrar = makeRegistrar(calls)
        await registrar.userChanged(uid: nil)
        XCTAssertEqual(calls.deletes, 0)
    }
}
