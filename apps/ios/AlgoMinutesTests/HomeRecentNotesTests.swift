import XCTest
@testable import AlgoMinutes

// MARK: - Home shows your latest notes (RELEASE.md rev 11, H16 / UX5)
//
// Home never showed a note: a recording just made went out of sight until its
// push arrived, unless you knew to look in Files.

final class HomeRecentNotesTests: XCTestCase {
    private func note(_ id: String, at created: String, status: String = "ready", duration: Double? = nil) -> Note {
        var data: [String: Any] = [
            "title": "Note \(id)",
            "workspaceId": "workspace_u1",
            "authorId": "u1",
            "status": status,
            "type": "recording",
            "createdAt": created,
            "updatedAt": created,
        ]
        if let duration { data["duration"] = duration }
        return Note(id: id, data: data)!
    }

    // RELEASE.md rev 11, H16: while it uploads it says how far; while it's processed, roughly how long is left.
    private let started = "2026-10-01T00:00:00.000Z"
    private func at(minutes: Double) -> Date { Note.parseISO(started)!.addingTimeInterval(minutes * 60) }

    func testAnUploadSaysHowFarItIs() {
        let uploading = note("a", at: started, status: "processing", duration: 3600)
        XCTAssertEqual(HomeView.recentStatus(uploading, uploadPercent: 40, now: at(minutes: 1)), "Uploading 40%")
        XCTAssertEqual(HomeView.recentStatus(uploading, uploadPercent: 140, now: at(minutes: 1)), "Uploading 100%")
    }

    func testAnHourIsUsuallyAboutEightMinutesAndFourHoursAboutTwentyThree() {
        XCTAssertEqual(HomeView.usualProcessingMinutes(recordingSeconds: 3600), 8)
        XCTAssertEqual(HomeView.usualProcessingMinutes(recordingSeconds: 4 * 3600), 23)
        XCTAssertEqual(HomeView.usualProcessingMinutes(recordingSeconds: 30), 4)
        XCTAssertEqual(HomeView.usualProcessingMinutes(recordingSeconds: -5), 3)
    }

    func testProcessingCountsDownThenSaysNearlyReadyThenThatItIsTakingLonger() {
        let hour = note("a", at: started, status: "transcribing", duration: 3600)
        XCTAssertEqual(HomeView.recentStatus(hour, now: at(minutes: 0)), "Transcribing… ready in about 8 min")
        XCTAssertEqual(HomeView.recentStatus(hour, now: at(minutes: 4.5)), "Transcribing… ready in about 4 min")
        XCTAssertEqual(HomeView.recentStatus(hour, now: at(minutes: 7.5)), "Transcribing… nearly ready")
        XCTAssertEqual(HomeView.recentStatus(hour, now: at(minutes: 10)), "Transcribing… nearly ready")
        XCTAssertEqual(HomeView.recentStatus(hour, now: at(minutes: 11)), "Transcribing… taking longer than usual")
    }

    func testThereIsNoEstimateWithoutARecordingLength() {
        XCTAssertEqual(HomeView.recentStatus(note("a", at: started, status: "summarizing"), now: at(minutes: 2)), "Summarizing…")
        XCTAssertNil(HomeView.processingEstimate(note("a", at: started, status: "summarizing", duration: 0), now: at(minutes: 2)))
    }

    func testAFinishedHeldOrFailedNoteNeverShowsAnEstimateOrAnUpload() {
        for (status, said) in [("ready", "Ready"), ("error", "Couldn’t process"), ("awaiting_minutes", "Waiting for minutes")] {
            XCTAssertEqual(HomeView.recentStatus(note("a", at: started, status: status, duration: 3600), uploadPercent: 50, now: at(minutes: 1)), said)
        }
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
