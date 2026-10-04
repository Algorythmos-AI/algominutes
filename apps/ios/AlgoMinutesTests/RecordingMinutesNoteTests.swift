import XCTest
@testable import AlgoMinutes

// MARK: - Minutes left, on the recording screen (RELEASE.md rev 11, H6d)
//
// A recording longer than the minutes left is held, not refused. The screen
// says so before it happens and when it has, and never tells anyone to stop.

final class RecordingMinutesNoteTests: XCTestCase {
    private func note(_ remaining: Double?, at elapsed: Int) -> String? {
        RecordingView.minutesNote(remainingMinutes: remaining, elapsedSeconds: elapsed)
    }

    func testSaysNothingWhenTheCountIsUnknownOrThePlanIsUnmetered() {
        XCTAssertNil(note(nil, at: 0))
        XCTAssertNil(note(nil, at: 10_000))
    }

    func testSaysNothingWhileThereIsPlentyLeft() {
        XCTAssertNil(note(600, at: 0))
        // 31 minutes before the minutes run out.
        XCTAssertNil(note(60, at: 29 * 60 - 1))
    }

    func testCountsDownOverTheLastHalfHourInMinutesNotSeconds() throws {
        let m = try XCTUnwrap(note(60, at: 30 * 60))
        XCTAssertTrue(m.hasPrefix("About 30 minutes"), m)
        XCTAssertTrue(m.contains("kept"), m)
        let near = try XCTUnwrap(note(60, at: 60 * 60 - 20))
        XCTAssertTrue(near.hasPrefix("Less than a minute"), near)
    }

    func testAShortBalanceShowsFromTheStart() throws {
        let m = try XCTUnwrap(note(12.6, at: 0))
        XCTAssertTrue(m.hasPrefix("About 13 minutes"), m)
    }

    func testPastTheMinutesItSaysTheRecordingIsKeptAndNeverToStop() throws {
        for elapsed in [60 * 60, 60 * 60 + 1, 3 * 60 * 60] {
            let m = try XCTUnwrap(note(60, at: elapsed))
            XCTAssertTrue(m.contains("longer than the minutes you have left"), m)
            XCTAssertTrue(m.contains("kept"), m)
            XCTAssertFalse(m.lowercased().contains("stop"), m)
        }
    }

    func testSaysNothingWhenThereWereNoMinutesToBeginWith() {
        // The invite sheet asks before such a recording starts (BillingService.guardMeteredAction).
        XCTAssertNil(note(0, at: 0))
        XCTAssertNil(note(-3, at: 120))
    }
}
