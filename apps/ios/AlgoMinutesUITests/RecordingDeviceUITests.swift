import XCTest

/// A real recording on the phone, through to a note on staging (opt-in: device-tests.sh --recording). The
/// microphone hears whatever is in the room. The note is deleted at the end, whatever happened before.
final class RecordingDeviceUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        // The note takes minutes to process (HomeView.usualProcessingMinutes: about 4 for 15 s).
        executionTimeAllowance = 900
    }

    /// Pause holds the time, Back minimises and the bar brings it back, End makes one note that gets processed,
    /// and Delete removes it (plan rev 12, I6: never yet verified on a device).
    @MainActor
    func testARecordingPausesMinimisesAndBecomesANote() throws {
        try requireOptIn("AM_UITEST_RECORDING", "--recording")
        let app = try launchToTabs()
        app.openTab("Home")
        let before = recentNoteIds(app)
        addTeardownBlock { @MainActor in self.cleanUpRecording(app, before: before) }
        try startRecording(app)

        waitUntilRecorded(app, seconds: 4)
        dismissAppAlerts(app)
        let pause = app.element("recording.pause")
        pause.tap()
        let paused = try XCTUnwrap(recordedSeconds(app))
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(recordedSeconds(app), paused, "the timer ran on while paused")
        pause.tap()
        waitUntilRecorded(app, seconds: paused + 3)

        // Back minimises: the recording carries on behind Home, and the bar opens it again.
        let beforeMinimise = try XCTUnwrap(recordedSeconds(app))
        app.element("recording.minimise").tap()
        let bar = app.element("recording.bar")
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "no recording bar after minimising")
        Thread.sleep(forTimeInterval: 3)
        openRecordingFromBar(app)
        XCTAssertTrue(app.element("recording.timer").waitForExistence(timeout: 5), "the bar didn't open the recording")
        XCTAssertGreaterThanOrEqual(recordedSeconds(app) ?? 0, beforeMinimise + 3, "the recording stopped while minimised")

        waitUntilRecorded(app, seconds: 15)
        let noteId = try endRecording(app, before: before)

        let status = waitUntilProcessed(app, noteId: noteId, timeout: 600)
        XCTContext.runActivity(named: "outcome: \(status)") { _ in }
        XCTAssertTrue(["Ready", "Couldn’t process"].contains(status), "the note wasn't processed in 10 min: \(status)")
        // Deleted here, through the note's own Delete; the teardown deletes it if the test stopped before.
        deleteNote(app, noteId: noteId)
    }
}
