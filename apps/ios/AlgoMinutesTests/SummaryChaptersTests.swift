import XCTest
@testable import AlgoMinutes

/// A long recording's chapters arrive in the note doc's `summary.chapters`
/// (the summarizer writes them, already validated and in order).
final class SummaryChaptersTests: XCTestCase {
    private func note(summary: [String: Any]) -> Note? {
        Note(id: "n1", data: [
            "title": "t", "workspaceId": "ws", "authorId": "u", "status": "ready", "type": "recording",
            "createdAt": "2026-09-25T00:00:00Z", "updatedAt": "2026-09-25T00:00:00Z",
            "summary": summary,
        ])
    }

    func testChaptersDecodeFromTheMirrorAndBadOnesAreSkipped() {
        let decoded = note(summary: [
            "gist": "g", "actionItems": [], "keyDecisions": [],
            "chapters": [
                ["startMs": NSNumber(value: 0), "title": "Intros", "summary": "Hello."],
                ["startMs": NSNumber(value: 1_800_000), "title": "Budget"],
                ["title": "No start"],
                ["startMs": NSNumber(value: 5), "title": ""],
            ],
        ])
        XCTAssertEqual(decoded?.summary?.chapters.map(\.title), ["Intros", "Budget"])
        XCTAssertEqual(decoded?.summary?.chapters.last?.summary, "")
        XCTAssertEqual(decoded?.summary?.chapters.last?.clock, "30:00")
    }

    func testAnOlderSummaryHasNoChapters() {
        XCTAssertEqual(note(summary: ["gist": "g", "actionItems": [], "keyDecisions": []])?.summary?.chapters, [])
    }

    func testTheClockReadsLikeTheTranscript() {
        XCTAssertEqual(SummaryChapter(startMs: 5_000, title: "t", summary: "").clock, "00:05")
        XCTAssertEqual(SummaryChapter(startMs: 3_723_000, title: "t", summary: "").clock, "1:02:03")
    }
}
