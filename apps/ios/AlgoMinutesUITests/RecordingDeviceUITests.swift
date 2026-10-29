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
        // It records on a signed-in account. This Debug build talks to staging, and keeps its own sign-in: one made
        // in a TestFlight or App Store build (production) isn't this one's (device run 20261028-154717).
        app.openTab("Settings")
        if app.element("settings.account.guest").waitForExistence(timeout: 5) {
            throw XCTSkip("this build (staging) is on a guest: sign in here, in Settings › Create account, first")
        }
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

    /// An app killed while recording (a crash, the system reclaiming memory, a force quit) gives the meeting back:
    /// the next launch makes it into a note by itself, and nothing deletes the audio first. On 2026-10-28 a
    /// recording cut off this way was offered, then gone from the phone a minute later (#516).
    @MainActor
    func testARecordingCutOffByAKillBecomesANote() throws {
        try requireOptIn("AM_UITEST_RECORDING", "--recording")
        let app = try launchToTabs()
        app.openTab("Settings")
        if app.element("settings.account.guest").waitForExistence(timeout: 5) {
            throw XCTSkip("this build (staging) is on a guest: sign in here, in Settings › Create account, first")
        }
        app.openTab("Home")
        let before = recentNoteIds(app)
        addTeardownBlock { @MainActor in self.cleanUpRecording(app, before: before) }
        try startRecording(app)
        waitUntilRecorded(app, seconds: 10)
        dismissAppAlerts(app)

        // Killed, not ended: nothing finishes the file or makes its note.
        app.terminate()
        _ = try launchToTabs(app)
        app.openTab("Home")

        var made: Set<String> = []
        let cameBack = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                made = self.recentNoteIds(app).subtracting(before)
                return made.count == 1
            }, object: nil
        )
        guard XCTWaiter().wait(for: [cameBack], timeout: 120) == .completed, let noteId = made.first else {
            screenshot(app, "no note from the killed recording")
            let waiting = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'not yet uploaded'")).firstMatch
            XCTFail(waiting.exists
                ? "the killed recording waits in \"\(waiting.label)\" instead of becoming a note"
                : "the killed recording is gone: no note, and nothing waiting to upload")
            return
        }
        let status = waitUntilProcessed(app, noteId: noteId, timeout: 600)
        XCTContext.runActivity(named: "outcome: \(status)") { _ in }
        XCTAssertTrue(["Ready", "Couldn’t process"].contains(status), "the note wasn't processed in 10 min: \(status)")
        deleteNote(app, noteId: noteId)
    }
}
