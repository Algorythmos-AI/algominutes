import XCTest
@testable import AlgoMinutes

/// A delete in flight hides its note at once; a refused delete brings it back.
@MainActor
final class NoteDeletionTests: XCTestCase {
    private func note(_ id: String) -> Note {
        Note(id: id, data: ["workspaceId": "workspace_u", "authorId": "u", "title": id, "status": "ready"])!
    }

    func testHidesOnlyTheNotesBeingDeletedAndKeepsTheOrder() {
        let notes = [note("a"), note("b"), note("c")]
        XCTAssertEqual(NotesRepository.visible(notes, hiding: []).map(\.id), ["a", "b", "c"])
        XCTAssertEqual(NotesRepository.visible(notes, hiding: ["b"]).map(\.id), ["a", "c"])
        XCTAssertEqual(NotesRepository.visible(notes, hiding: ["a", "c", "zz"]).map(\.id), ["b"])
    }
}
