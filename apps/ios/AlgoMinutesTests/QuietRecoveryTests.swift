import XCTest
@testable import AlgoMinutes

/// Which recordings without a note the app makes into notes by itself (AppEnvironment.quietlyRecoverable). Home used
/// to ask about them with an alert on every visit until answered (device run 2026-10-28).
@MainActor
final class QuietRecoveryTests: XCTestCase {
    private func recording(_ name: String, noteId: String? = nil, projectId: String? = nil) -> RecordingStore.PendingRecording {
        var r = RecordingStore.PendingRecording(
            recordingId: name, fileName: "recording_\(name).m4a", mimeType: "audio/mp4", ext: "m4a",
            durationSeconds: nil, noteId: noteId, createdAt: Date()
        )
        r.projectId = projectId
        return r
    }

    func testARecordingTheAppStoppedBeforeMakingANoteIsRecovered() {
        let found = AppEnvironment.quietlyRecoverable([recording("a")], inFlight: nil, isRecording: false, alreadyTried: [])
        XCTAssertEqual(found.map(\.fileName), ["recording_a.m4a"])
    }

    func testOneWithANoteResumesInstead() {
        XCTAssertTrue(AppEnvironment.quietlyRecoverable(
            [recording("a", noteId: "n1")], inFlight: nil, isRecording: false, alreadyTried: []
        ).isEmpty)
    }

    /// Moved here from the other build's backend: it may be another account's, so it waits for Upload.
    func testOneFromTheOtherBackendWaitsForUpload() {
        XCTAssertTrue(AppEnvironment.quietlyRecoverable(
            [recording("a", projectId: "algominutes-staging")], inFlight: nil, isRecording: false, alreadyTried: []
        ).isEmpty)
    }

    func testNothingWhileRecordingAndNeverTheFileBeingRecorded() {
        XCTAssertTrue(AppEnvironment.quietlyRecoverable([recording("a")], inFlight: nil, isRecording: true, alreadyTried: []).isEmpty)
        XCTAssertTrue(AppEnvironment.quietlyRecoverable(
            [recording("a")], inFlight: "recording_a.m4a", isRecording: false, alreadyTried: []
        ).isEmpty)
    }

    /// Once per launch: one that couldn't be made into a note isn't tried again and again.
    func testOnceEach() {
        XCTAssertTrue(AppEnvironment.quietlyRecoverable(
            [recording("a")], inFlight: nil, isRecording: false, alreadyTried: ["recording_a.m4a"]
        ).isEmpty)
    }
}
