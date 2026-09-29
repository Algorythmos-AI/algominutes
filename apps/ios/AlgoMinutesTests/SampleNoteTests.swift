import XCTest
@testable import AlgoMinutes

/// The example note (RELEASE.md PR 10b): a finished note to look at before the
/// first recording, local only, with nothing to play or fetch.
final class SampleNoteTests: XCTestCase {
    func testItIsAFinishedNoteWithASummaryAndATranscript() {
        let note = SampleNote.note
        XCTAssertEqual(note.status, .ready)
        XCTAssertFalse(note.summary?.gist.isEmpty ?? true)
        XCTAssertFalse(note.summary?.actionItems.isEmpty ?? true)
        XCTAssertFalse(note.summary?.chapters.isEmpty ?? true)
        XCTAssertFalse(SampleNote.lines.isEmpty)
        XCTAssertNotEqual(note.transcriptTruncated, true)
    }

    func testItHasNothingToPlayOrFetch() {
        XCTAssertNil(SampleNote.note.storagePath)
        XCTAssertEqual(SampleNote.note.workspaceId, "")
    }

    func testItsLinesHaveUniqueIds() {
        XCTAssertEqual(Set(SampleNote.lines.map(\.id)).count, SampleNote.lines.count)
    }

    func testItShowsOnlyWhileThereAreNoNotes() {
        XCTAssertTrue(SampleNote.shouldShow(notesEmpty: true, query: "", hasLoaded: true, hidden: false))
        XCTAssertTrue(SampleNote.shouldShow(notesEmpty: true, query: "   ", hasLoaded: true, hidden: false))
        XCTAssertFalse(SampleNote.shouldShow(notesEmpty: false, query: "", hasLoaded: true, hidden: false))
        XCTAssertFalse(SampleNote.shouldShow(notesEmpty: true, query: "", hasLoaded: false, hidden: false)) // no flash while loading
        XCTAssertFalse(SampleNote.shouldShow(notesEmpty: true, query: "", hasLoaded: true, hidden: true))
        XCTAssertFalse(SampleNote.shouldShow(notesEmpty: true, query: "sync", hasLoaded: true, hidden: false))
        XCTAssertFalse(SampleNote.shouldShow(notesEmpty: true, query: "", hasLoaded: true, hidden: false, filterMatches: false))
    }

    func testItFollowsTheFilesFilters() {
        // A voice note: under All and Voice Note, not Imported or Scanned.
        let shown = FilesView.SourceFilter.allCases.filter { $0.matches(SampleNote.note) }
        XCTAssertEqual(Set(shown), [.all, .voiceNote])
    }
}
