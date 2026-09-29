import XCTest
@testable import AlgoMinutes

/// A notetaker's note (RELEASE.md PR 23): what its notetaker is doing, in
/// words, what the user can do about it, and never an error for a status this
/// build doesn't know.
final class NotetakerNoteTests: XCTestCase {
    private func doc(_ status: String, noteStatus: String = "recording", extra: [String: Any] = [:]) -> [String: Any] {
        var d: [String: Any] = [
            "workspaceId": "workspace_u", "title": "Weekly sync", "authorId": "u", "status": noteStatus,
            "type": "online_meeting", "sourceKind": "bot", "createdAt": "2026-09-30T01:00:00.000Z", "updatedAt": "2026-09-30T01:00:00.000Z",
            "notetaker": ["botId": "b0a1b2c3-0000-4000-8000-000000000001", "status": status, "platform": "google_meet", "rank": 30],
        ]
        extra.forEach { d[$0.key] = $0.value }
        return d
    }

    func testANotetakerNoteSaysWhatItsNotetakerIsDoing() throws {
        let note = try XCTUnwrap(Note(id: "n1", data: doc("waiting_room")))
        XCTAssertEqual(note.sourceKind, "bot")
        XCTAssertEqual(note.notetaker?.botId, "b0a1b2c3-0000-4000-8000-000000000001")
        XCTAssertEqual(note.statusLabel, "Notetaker waiting to be let in")
        XCTAssertEqual(note.notetaker?.action, .cancel)
        let stage = NoteProcessingStage.from(status: note.status, progress: nil, uploadPercent: nil, notetaker: note.notetaker)
        XCTAssertEqual(stage.label, "Notetaker waiting to be let in")
    }

    func testWhileRecordingItCanBeStopped_andOnceOverNothingIsOffered() throws {
        XCTAssertEqual(try XCTUnwrap(Note(id: "n1", data: doc("recording"))).notetaker?.action, .stop)
        let over = try XCTUnwrap(Note(id: "n1", data: doc("processing")))
        XCTAssertNil(over.notetaker?.action)
        XCTAssertEqual(over.statusLabel, "Meeting over: getting the recording")
    }

    func testAStatusThisBuildDoesntKnowReadsAsInProgress() throws {
        let note = try XCTUnwrap(Note(id: "n1", data: doc("teleporting")))
        XCTAssertEqual(note.statusLabel, "Notetaker in progress")
        XCTAssertNil(note.notetaker?.action)
    }

    func testAnyOtherNoteIsUnchanged() throws {
        var d = doc("recording")
        d.removeValue(forKey: "notetaker")
        d["sourceKind"] = nil
        let note = try XCTUnwrap(Note(id: "n1", data: d))
        XCTAssertNil(note.notetaker)
        XCTAssertEqual(note.statusLabel, "Recording")
        XCTAssertEqual(NoteProcessingStage.from(status: .recording, progress: nil, uploadPercent: nil).label, "Recording")
        // A ready notetaker note reads as ready.
        XCTAssertEqual(try XCTUnwrap(Note(id: "n1", data: doc("done", noteStatus: "ready"))).statusLabel, "Ready")
    }

    func testAMalformedNotetakerIsIgnored_notTheNote() throws {
        let note = try XCTUnwrap(Note(id: "n1", data: doc("recording", extra: ["notetaker": ["status": "recording"]])))
        XCTAssertNil(note.notetaker)
        XCTAssertEqual(note.statusLabel, "Recording")
    }
}
