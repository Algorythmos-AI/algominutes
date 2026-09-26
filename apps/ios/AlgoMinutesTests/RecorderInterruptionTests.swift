import XCTest
@testable import AlgoMinutes

/// PR-23: a long recording stops and keeps what it has when the disk runs low
/// mid-way or the system's audio restarts, and says why.
final class RecorderInterruptionTests: XCTestCase {
    func testStorageFloorStopsOnlyBelowItAndNeverOnAnUnknownReading() {
        let floor = RecorderService.minFreeBytesWhileRecording
        XCTAssertTrue(RecorderService.isStorageTooLow(freeBytes: floor - 1))
        XCTAssertFalse(RecorderService.isStorageTooLow(freeBytes: floor))
        XCTAssertFalse(RecorderService.isStorageTooLow(freeBytes: nil))
        // The mid-recording floor sits well under the start-time check, so a
        // recording that started can run on as other apps use space.
        XCTAssertLessThan(floor, RecorderService.minFreeBytesToRecord)
    }

    @MainActor
    func testEachNewStopReasonSaysWhatHappenedAndWhetherAudioWasKept() {
        let kept = RecorderService.StopResult(fileURL: URL(fileURLWithPath: "/tmp/r.aac"), sizeBytes: 1024, durationSeconds: 60, recordingFailed: false)
        for reason in [RecorderService.AutoStop.Reason.lowStorage, .mediaServicesReset] {
            let withAudio = RecorderService.AutoStop(reason: reason, result: kept, at: Date()).message
            let without = RecorderService.AutoStop(reason: reason, result: nil, at: Date()).message
            XCTAssertTrue(withAudio.contains("kept what was recorded"), withAudio)
            XCTAssertTrue(without.contains("No audio had been captured"), without)
        }
        XCTAssertTrue(RecorderService.AutoStop(reason: .lowStorage, result: kept, at: Date()).message.contains("storage"))
        XCTAssertTrue(RecorderService.AutoStop(reason: .mediaServicesReset, result: kept, at: Date()).message.contains("audio system"))
    }
}
