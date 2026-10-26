import XCTest
@testable import AlgoMinutes

// MARK: - The upload stall watch and a PUT's outcome (RELEASE.md rev 11, H3/N5)
//
// A stuck upload used to wait out URLSession's 7-day resource timeout with its
// progress frozen on screen; the watch cancels it so the retry continues from
// the server's byte count. It must never cancel a healthy one.

final class UploadStallWatchTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    /// Checks every 15 s from `from` to `to` with a fixed byte count, returning the last verdict.
    private func run(_ w: inout UploadStallPolicy.Watch, bytes: Int64, from: TimeInterval, to: TimeInterval, usable: Bool = true) -> UploadStallPolicy.Verdict {
        var verdict = UploadStallPolicy.Verdict.healthy
        var s = from
        while s <= to {
            verdict = UploadStallPolicy.step(&w, bytesSent: bytes, networkUsable: usable, now: at(s))
            if verdict != .healthy { return verdict }
            s += UploadStallPolicy.checkIntervalSeconds
        }
        return verdict
    }

    func testNoBytesForTwoMinutesIsAStall() {
        var w = UploadStallPolicy.Watch(bytes: 100, now: t0)
        XCTAssertEqual(run(&w, bytes: 100, from: 15, to: 105), .healthy)
        XCTAssertEqual(UploadStallPolicy.step(&w, bytesSent: 100, networkUsable: true, now: at(120)), .stalled)
    }

    func testBytesMovingIsHealthyHoweverSlow() {
        var w = UploadStallPolicy.Watch(bytes: 0, now: t0)
        var s: TimeInterval = 15
        var bytes: Int64 = 0
        while s < 1800 {
            bytes += 1
            XCTAssertEqual(UploadStallPolicy.step(&w, bytesSent: bytes, networkUsable: true, now: at(s)), .healthy)
            s += 15
        }
    }

    func testWaitingForTheNetworkIsNotAStall() {
        // Wi-Fi only on cellular, or offline: the background session waits silently.
        var w = UploadStallPolicy.Watch(bytes: 0, now: t0)
        XCTAssertEqual(run(&w, bytes: 0, from: 15, to: 7200, usable: false), .healthy)
        // Back online and still nothing moves: then it's a stall.
        XCTAssertEqual(run(&w, bytes: 0, from: 7215, to: 7400), .stalled)
    }

    func testASuspensionGapIsNotAStall() {
        // The app was suspended for an hour; the daemon kept sending, and the
        // count hasn't caught up on the first check back.
        var w = UploadStallPolicy.Watch(bytes: 500, now: t0)
        XCTAssertEqual(UploadStallPolicy.step(&w, bytesSent: 500, networkUsable: true, now: at(3600)), .healthy)
        XCTAssertEqual(UploadStallPolicy.step(&w, bytesSent: 900, networkUsable: true, now: at(3615)), .healthy)
    }

    func testTheCeilingCountsOnlyTimeTheNetworkCouldCarryIt() {
        var w = UploadStallPolicy.Watch(bytes: 0, now: t0)
        var s: TimeInterval = 15
        var bytes: Int64 = 0
        var verdict = UploadStallPolicy.Verdict.healthy
        while s <= UploadStallPolicy.hardCeilingSeconds + 30 {
            bytes += 1
            verdict = UploadStallPolicy.step(&w, bytesSent: bytes, networkUsable: true, now: at(s))
            if verdict != .healthy { break }
            s += 15
        }
        XCTAssertEqual(verdict, .exceededCeiling)
    }

    func testWifiOnlyNeedsWifi() {
        XCTAssertTrue(UploadStallPolicy.networkAllowsUpload(connected: true, onWifi: false, wifiOnly: false))
        XCTAssertFalse(UploadStallPolicy.networkAllowsUpload(connected: true, onWifi: false, wifiOnly: true))
        XCTAssertTrue(UploadStallPolicy.networkAllowsUpload(connected: true, onWifi: true, wifiOnly: true))
        XCTAssertFalse(UploadStallPolicy.networkAllowsUpload(connected: false, onWifi: true, wifiOnly: false))
    }
}

final class UploadPutOutcomeTests: XCTestCase {
    func testFinalisedIsDone() {
        XCTAssertNil(BackgroundUploadService.outcome(error: nil, status: 200))
        XCTAssertNil(BackgroundUploadService.outcome(error: nil, status: 201))
    }

    func testA308OnTheRestOfTheFileIsNotDone() {
        // Each PUT sends the rest of the file: a session still open means GCS didn't take it all.
        guard case .incomplete? = BackgroundUploadService.outcome(error: nil, status: 308) as? UploadError else {
            return XCTFail("a 308 must not count as a finished upload")
        }
    }

    func testOtherAnswersAndErrorsFail() {
        guard case .failed? = BackgroundUploadService.outcome(error: nil, status: 503) as? UploadError else { return XCTFail("503") }
        guard case .failed? = BackgroundUploadService.outcome(error: nil, status: nil) as? UploadError else { return XCTFail("no answer") }
        let dropped = URLError(.networkConnectionLost)
        XCTAssertEqual((BackgroundUploadService.outcome(error: dropped, status: nil) as? URLError)?.code, .networkConnectionLost)
    }
}
