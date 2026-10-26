import XCTest
@testable import AlgoMinutes

// MARK: - Find in the transcript (RELEASE.md rev 11, UX12)
//
// A long meeting is hundreds of lines, and the only way to a remembered phrase
// was to scroll for it.

final class FindInTranscriptTests: XCTestCase {
    private func line(_ index: Int, _ speaker: String, _ text: String) -> TranscriptLine {
        TranscriptLine(index: index, speaker: speaker, text: text, time: "00:0\(index)", startMs: nil)
    }

    private var lines: [TranscriptLine] {
        [
            line(0, "Priya", "We agreed the Q3 budget."),
            line(1, "Sam", "Hiring opens in Sydney next month."),
            line(2, "Priya", "The café booking is for Friday."),
            line(3, "Sam", "Budget sign-off is with finance."),
        ]
    }

    func testAnEmptyQueryShowsEveryLine() {
        XCTAssertEqual(TranscriptPane.matching(lines, query: "").count, 4)
        XCTAssertEqual(TranscriptPane.matching(lines, query: "   ").count, 4)
    }

    func testItFindsWordsWhateverTheirCaseOrAccentsInOrder() {
        XCTAssertEqual(TranscriptPane.matching(lines, query: "budget").map(\.index), [0, 3])
        XCTAssertEqual(TranscriptPane.matching(lines, query: " BUDGET ").map(\.index), [0, 3])
        XCTAssertEqual(TranscriptPane.matching(lines, query: "cafe").map(\.index), [2])
    }

    func testItFindsASpeakerByName() {
        XCTAssertEqual(TranscriptPane.matching(lines, query: "priya").map(\.index), [0, 2])
    }

    func testNothingMatchingIsNoLines() {
        XCTAssertTrue(TranscriptPane.matching(lines, query: "zebra").isEmpty)
    }

    func testTheCountIsSaidInWords() {
        XCTAssertEqual(TranscriptPane.findSummary(matches: 0), "No lines match")
        XCTAssertEqual(TranscriptPane.findSummary(matches: 1), "1 line matches")
        XCTAssertEqual(TranscriptPane.findSummary(matches: 12), "12 lines match")
    }
}
