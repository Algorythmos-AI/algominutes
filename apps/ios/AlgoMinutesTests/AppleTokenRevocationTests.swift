import XCTest
@testable import AlgoMinutes

/// Only an account signed in with Apple has tokens to revoke on deletion.
final class AppleTokenRevocationTests: XCTestCase {
    func testOnlyAnAppleLinkedAccountIsRevoked() {
        XCTAssertTrue(AppleTokenRevocation.isAppleLinked(providerIDs: ["apple.com"]))
        XCTAssertTrue(AppleTokenRevocation.isAppleLinked(providerIDs: ["google.com", "apple.com"]))
        XCTAssertFalse(AppleTokenRevocation.isAppleLinked(providerIDs: ["google.com"]))
        XCTAssertFalse(AppleTokenRevocation.isAppleLinked(providerIDs: [])) // anonymous
    }
}
