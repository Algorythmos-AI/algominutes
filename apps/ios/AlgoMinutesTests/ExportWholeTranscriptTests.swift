import XCTest
@testable import AlgoMinutes

// MARK: - An export holds the whole transcript (RELEASE.md rev 11, H17 / LM7)
//
// The Firestore mirror carries a note's first 200 lines. A PDF or text file
// made before the rest had loaded held only those, and nothing said so.

final class ExportWholeTranscriptTests: XCTestCase {
    func testAnExportWithATranscriptWaitsWhenTheMirrorIsAtItsCap() {
        let cap = TranscriptRepository.mirrorCap
        XCTAssertEqual(cap, 200)
        for scope in [ExportScope.transcript, .both] {
            XCTAssertTrue(TranscriptRepository.exportNeedsFull(scope: scope, mirroredCount: cap), scope.rawValue)
            XCTAssertTrue(TranscriptRepository.exportNeedsFull(scope: scope, mirroredCount: cap + 50), scope.rawValue)
        }
    }

    func testAShortNoteIsAlreadyWholeAndASummaryHasNoTranscriptInIt() {
        let cap = TranscriptRepository.mirrorCap
        XCTAssertFalse(TranscriptRepository.exportNeedsFull(scope: .both, mirroredCount: cap - 1))
        XCTAssertFalse(TranscriptRepository.exportNeedsFull(scope: .transcript, mirroredCount: 0))
        XCTAssertFalse(TranscriptRepository.exportNeedsFull(scope: .summary, mirroredCount: cap))
    }

    func testAFailureSaysNothingWasExportedRatherThanExportingPart() {
        let message = NoteDetailView.wholeTranscriptNeededMessage
        XCTAssertTrue(message.contains("nothing was exported"), message)
        XCTAssertTrue(message.contains("try again"), message)
    }
}
