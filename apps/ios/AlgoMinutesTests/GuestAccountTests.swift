import XCTest
@testable import AlgoMinutes

/// A guest's notes live only under the guest account: nothing may end it
/// without saying so.
final class GuestAccountTests: XCTestCase {
    func testAGuestIsToldSigningOutLosesTheirNotes() {
        let message = SettingsView.signOutWarning(isGuest: true, pendingRecordings: 0)
        XCTAssertTrue(message.contains("can't be undone"))
        XCTAssertTrue(message.contains("Create an account"))
    }

    func testUnsentRecordingsAreCountedForEveryone() {
        XCTAssertTrue(SettingsView.signOutWarning(isGuest: false, pendingRecordings: 1).hasPrefix("One recording"))
        XCTAssertTrue(SettingsView.signOutWarning(isGuest: false, pendingRecordings: 3).hasPrefix("3 recordings"))
        let both = SettingsView.signOutWarning(isGuest: true, pendingRecordings: 2)
        XCTAssertTrue(both.contains("guest") && both.contains("2 recordings"))
    }

    func testASignedInUserWithNothingPendingHasNothingToWarnAbout() {
        XCTAssertEqual(SettingsView.signOutWarning(isGuest: false, pendingRecordings: 0), "")
    }
}
