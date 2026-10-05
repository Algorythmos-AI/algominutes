import XCTest
@testable import AlgoMinutes

// MARK: - Edit a summary by hand (RELEASE.md rev 11, UX12)
//
// The web could; the iPhone could only rewrite the whole summary.

final class EditSummaryTests: XCTestCase {
    private let original = Summary(
        gist: "A planning meeting.",
        actionItems: ["Sam sends the deck", "Priya books the room"],
        keyDecisions: ["Ship on Friday"],
        keyPoints: ["Budget agreed"]
    )

    func testItemsAreOnePerLineTrimmedWithEmptyLinesLeftOut() {
        XCTAssertEqual(EditSummarySheet.lines("  Sam sends the deck \n\n\nPriya books the room\n   \n"), ["Sam sends the deck", "Priya books the room"])
        XCTAssertEqual(EditSummarySheet.lines(""), [])
    }

    func testAnEditChangesWhatWasTypedAndKeepsWhatTheFormDoesNotShow() throws {
        let next = try XCTUnwrap(EditSummarySheet.edited(original, gist: " A budget meeting. ", actions: "Sam sends the deck", decisions: "Ship on Friday\nHire in Sydney"))
        XCTAssertEqual(next.gist, "A budget meeting.")
        XCTAssertEqual(next.actionItems, ["Sam sends the deck"])
        XCTAssertEqual(next.keyDecisions, ["Ship on Friday", "Hire in Sydney"])
        XCTAssertEqual(next.keyPoints, ["Budget agreed"])
        XCTAssertEqual(next.chapters, original.chapters)
    }

    func testThereIsNothingToSaveWithoutAChangeOrWithAnEmptySummary() {
        XCTAssertNil(EditSummarySheet.edited(original, gist: "A planning meeting.", actions: "Sam sends the deck\nPriya books the room", decisions: "Ship on Friday"))
        XCTAssertNil(EditSummarySheet.edited(original, gist: "   \n ", actions: "x", decisions: "y"))
    }

    func testEveryItemCanBeRemoved() throws {
        let next = try XCTUnwrap(EditSummarySheet.edited(original, gist: original.gist, actions: "", decisions: ""))
        XCTAssertEqual(next.actionItems, [])
        XCTAssertEqual(next.keyDecisions, [])
    }

    func testAVeryLongSummaryIsCutAtTheServersLimit() throws {
        let next = try XCTUnwrap(EditSummarySheet.edited(original, gist: String(repeating: "a", count: 25_000), actions: "", decisions: ""))
        XCTAssertEqual(next.gist.count, EditSummarySheet.maxGistCharacters)
    }
}
