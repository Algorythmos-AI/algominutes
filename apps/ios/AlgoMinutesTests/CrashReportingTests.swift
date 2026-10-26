import XCTest
@testable import AlgoMinutes

// RELEASE.md rev 11, H15: Crashlytics groups reports by a hash of the uid, never the uid itself.
final class CrashReportingTests: XCTestCase {
    func testTheUserIdIsAStableHashNotTheUid() {
        let uid = "Xk3uV9sLq2PzR8tYw1Ab"
        let hashed = CrashReporting.hashedUserId(uid)
        XCTAssertEqual(hashed.count, 16)
        XCTAssertEqual(hashed, CrashReporting.hashedUserId(uid), "the same user hashes the same")
        XCTAssertNotEqual(hashed, CrashReporting.hashedUserId("another-uid"))
        XCTAssertFalse(hashed.contains(uid))
        XCTAssertTrue(hashed.allSatisfy { $0.isHexDigit })
    }

    func testAKnownValue() {
        // SHA-256("abc") begins ba7816bf8f01cfea.
        XCTAssertEqual(CrashReporting.hashedUserId("abc"), "ba7816bf8f01cfea")
    }
}
