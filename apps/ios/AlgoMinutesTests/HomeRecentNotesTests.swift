import XCTest
@testable import AlgoMinutes

// MARK: - Home shows your latest notes (RELEASE.md rev 11, H16 / UX5)
//
// Home never showed a note: a recording just made went out of sight until its
// push arrived, unless you knew to look in Files.

final class HomeRecentNotesTests: XCTestCase {
    private func note(_ id: String, at created: String, status: String = "ready") -> Note {
        Note(id: id, data: [
            "title": "Note \(id)",
            "workspaceId": "workspace_u1",
            "authorId": "u1",
            "status": status,
            "type": "recording",
            "createdAt": created,
            "updatedAt": created,
        ])!
    }

    func testTheLatestThreeAreShownNewestFirstWhateverOrderTheyArriveIn() {
        let notes = [
            note("a", at: "2026-10-01T00:00:00.000Z"),
            note("d", at: "2026-10-04T00:00:00.000Z"),
            note("b", at: "2026-10-02T00:00:00.000Z"),
            note("c", at: "2026-10-03T00:00:00.000Z"),
        ]
        XCTAssertEqual(HomeView.recent(notes).map(\.id), ["d", "c", "b"])
        XCTAssertEqual(HomeView.recentLimit, 3)
    }

    func testFewerNotesThanTheLimitAreAllShownAndNoneIsNone() {
        XCTAssertEqual(HomeView.recent([note("a", at: "2026-10-01T00:00:00.000Z")]).map(\.id), ["a"])
        XCTAssertTrue(HomeView.recent([]).isEmpty)
    }

    func testEachStatusIsSaidInPlainWords() {
        let at = "2026-10-01T00:00:00.000Z"
        XCTAssertEqual(HomeView.recentStatus(note("a", at: at, status: "ready")), "Ready")
        XCTAssertEqual(HomeView.recentStatus(note("a", at: at, status: "error")), "Couldn’t process")
        XCTAssertEqual(HomeView.recentStatus(note("a", at: at, status: "awaiting_minutes")), "Waiting for minutes")
        XCTAssertEqual(HomeView.recentStatus(note("a", at: at, status: "transcribing")), "Transcribing…")
        XCTAssertEqual(HomeView.recentStatus(note("a", at: at, status: "summarizing")), "Summarizing…")
    }
}
