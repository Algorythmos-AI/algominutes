import XCTest
@testable import AlgoMinutes

// MARK: - A search result opens its note at the moment it matched (RELEASE.md rev 11, UX8)
//
// It used to open the note at the top of its summary, and the match had to be found again.

final class OpenAtMomentTests: XCTestCase {
    /// One line every 30 seconds, as the transcript has them.
    private func lines(_ count: Int) -> [TranscriptLine] {
        (0..<count).map { i in
            TranscriptLine(index: i, speaker: "", text: "line \(i)", time: "", startMs: Double(i) * 30_000)
        }
    }

    func testItOpensAtTheLineThatWasBeingSaidAtThatMoment() {
        let all = lines(20)
        XCTAssertEqual(TranscriptPane.momentIndex(in: all, atMs: 0, complete: true), 0)
        XCTAssertEqual(TranscriptPane.momentIndex(in: all, atMs: 95_000, complete: true), 3)
        XCTAssertEqual(TranscriptPane.momentIndex(in: all, atMs: 90_000, complete: true), 3)
        XCTAssertEqual(TranscriptPane.momentIndex(in: all, atMs: 9_999_000, complete: true), 19)
    }

    func testAMomentPastTheLinesOnThisIPhoneWaitsForTheRest() {
        // The mirror: the first 200 lines of a long note (100 minutes of it).
        let mirror = lines(200)
        // A match at minute 150 is not in it: wait, rather than land on line 200.
        XCTAssertNil(TranscriptPane.momentIndex(in: mirror, atMs: 150 * 60_000, complete: false))
        // A match inside the mirror opens at once.
        XCTAssertEqual(TranscriptPane.momentIndex(in: mirror, atMs: 10 * 60_000, complete: false), 20)
        // The rest has loaded: now it's there.
        XCTAssertEqual(TranscriptPane.momentIndex(in: lines(400), atMs: 150 * 60_000, complete: true), 300)
        // The rest couldn't be loaded: the nearest line there is.
        XCTAssertEqual(TranscriptPane.momentIndex(in: mirror, atMs: 150 * 60_000, complete: true), 199)
    }

    func testTheLastLineOfAnIncompleteTranscriptIsStillOpenedWhenTheMomentIsInIt() {
        let mirror = lines(200)
        XCTAssertEqual(TranscriptPane.momentIndex(in: mirror, atMs: 199 * 30_000 + 5_000, complete: false), 199)
    }

    func testNoLinesIsNowhereToOpenAndANegativeMomentIsTheStart() {
        XCTAssertNil(TranscriptPane.momentIndex(in: [], atMs: 1_000, complete: true))
        XCTAssertEqual(TranscriptPane.momentIndex(in: lines(3), atMs: -5, complete: true), 0)
    }

    func testEachLineHasItsOwnScrollAnchor() {
        XCTAssertNotEqual(TranscriptPane.anchor(1), TranscriptPane.anchor(11))
    }
}
