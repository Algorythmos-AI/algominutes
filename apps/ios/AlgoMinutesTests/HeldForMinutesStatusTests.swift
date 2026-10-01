import XCTest
@testable import AlgoMinutes

// MARK: - Held for minutes (RELEASE.md rev 11, H6)
//
// A recording longer than the minutes left is held, not failed: the note is
// neither in progress (no spinner, no stuck-note retry) nor an error.

final class HeldForMinutesStatusTests: XCTestCase {
    private func note(status: String) -> Note? {
        Note(id: "n1", data: [
            "title": "t",
            "workspaceId": "workspace_u1",
            "authorId": "u1",
            "status": status,
            "type": "recording",
            "createdAt": "2026-10-01T00:00:00.000Z",
            "updatedAt": "2026-10-01T00:00:00.000Z",
        ])
    }

    func testTheServersStatusDecodesAsHeld() {
        XCTAssertEqual(note(status: "awaiting_minutes")?.status, .awaitingMinutes)
        XCTAssertEqual(NoteStatus.awaitingMinutes.label, "Waiting for minutes")
    }

    func testAHeldNoteIsNotInProgressAndNeverStuck() {
        XCTAssertFalse(NoteStatus.awaitingMinutes.isInProgress)
        guard let held = note(status: "awaiting_minutes") else { return XCTFail("the note didn't decode") }
        // Days after its last update: still not "stuck", so no retry is offered.
        XCTAssertFalse(StuckBudgets.isStuck(note: held, now: Date(timeIntervalSinceNow: 60 * 60 * 24 * 30)))
    }
}
