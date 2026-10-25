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

    /// Plan rev 12 S6: a failed revocation was logged and the deletion went ahead, leaving Apple's tokens valid
    /// with no second chance. It now asks: Try again (a fresh Apple prompt) or Delete anyway, so the person can
    /// always delete (5.1.1(v)) and a passing failure doesn't silently skip the revocation.
    func testWhatDeletionDoesAfterAskingApple() {
        struct Boom: Error {}
        XCTAssertEqual(AppleRevocationStep.after(.success(.revoked)), .delete)
        XCTAssertEqual(AppleRevocationStep.after(.success(.notLinked)), .delete)
        XCTAssertEqual(AppleRevocationStep.after(.success(.cancelled)), .stop)
        XCTAssertEqual(AppleRevocationStep.after(.failure(Boom())), .askTryAgainOrDeleteAnyway)
    }

    func testTheFailureSaysWhatHappenedAndWhatEachChoiceMeans() {
        let message = AppleRevocationStep.failedMessage
        XCTAssertTrue(message.contains("Apple"))
        XCTAssertTrue(message.contains("Try again"))
        XCTAssertTrue(message.contains("Delete anyway"))
        XCTAssertFalse(message.contains("Error"), "a sentence, not an error code (UX7)")
    }
}
